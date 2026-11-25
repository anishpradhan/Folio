"""The quick pass: a document answers from its text layer while Docling (here a stand-in) reads the layout."""

import hashlib
import io
import json
import threading
from typing import Any, Callable, Iterator

import pytest
from fastapi.testclient import TestClient

from folio_ai.app import create_app
from folio_ai.config import Settings
from folio_ai.ingestion import worker as worker_mod
from folio_ai.ingestion.pipeline import IngestionError
from folio_ai.ingestion.quick import quick_chunks
from folio_ai.services import Services
from tests.conftest import FIXTURES, FakeParser, wait_for


class GatedParser(FakeParser):
    """The full pass waits at the gate, so the quick state can be looked at."""

    def __init__(self) -> None:
        super().__init__()
        self.gate = threading.Event()

    def parse(self, pdf_path: str, out_json: str, on_progress: Callable[[int, int], None] | None = None) -> None:
        if on_progress:
            on_progress(1, 2)
        assert self.gate.wait(20), "the test never opened the gate"
        super().parse(pdf_path, out_json, on_progress)

    def cancel(self) -> None:
        self.gate.set()


@pytest.fixture
def parser() -> GatedParser:
    return GatedParser()


@pytest.fixture
def client(settings: Settings, services: Services, parser: GatedParser, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(worker_mod, "RETRY_BACKOFF_S", (0, 0, 0))
    settings.quick_index = True
    app = create_app(settings, parser=parser, services=services)
    with TestClient(app) as c:
        app.state.rt.worker.poll_s = 0.05
        app.state.rt.quick_worker.poll_s = 0.05
        yield c
        parser.gate.set()


def upload(client: TestClient, data: bytes) -> str:
    digest = hashlib.sha256(data).hexdigest()
    r = client.post("/api/ai/documents", files={"file": ("notes.pdf", data, "application/pdf")}, data={"sha256": digest, "title": "Plain notes"})
    assert r.status_code == 202, r.text
    return digest


def doc(client: TestClient, digest: str) -> dict[str, Any]:
    return client.get(f"/api/ai/documents/{digest}").json()


def wait_doc(client: TestClient, digest: str, pred: Callable[[dict[str, Any]], bool]) -> dict[str, Any]:
    out: dict[str, Any] = {}

    def done() -> bool:
        out.clear()
        out.update(doc(client, digest))
        return pred(out)

    wait_for(done)
    return out


def chunk_items(client: TestClient, digest: str) -> list[dict[str, Any]]:
    return client.get(f"/api/ai/documents/{digest}/chunks", params={"limit": 500}).json()["items"]


def test_quick_chunks_keep_pages_rectangles_and_citation_blocks() -> None:
    d = quick_chunks("doc", FIXTURES / "quiet-art.pdf", "fake-embed-64", max_tokens=200, title="The Quiet Art of Reading")
    assert d.page_count == 10 and d.sections == [] and len(d.chunks) > 3
    assert all(c.id == f"doc:q{c.ordinal}" for c in d.chunks)
    assert all(c.embed_text.startswith("The Quiet Art of Reading\n") for c in d.chunks)
    for c in d.chunks:
        assert 1 <= c.page_start <= c.page_end <= 10
        assert c.locations and all(0 <= l["rect"]["x"] < 1 and 0 < l["rect"]["w"] <= 1 and 0 <= l["rect"]["y"] < 1 for l in c.locations)
        assert c.blocks and all(b["locations"] for b in c.blocks)
        assert c.token_count <= 200
    text = "\n".join(c.text for c in d.chunks)
    assert "Reading is a slow art." in text
    assert "\n2\n" not in f"\n{text}\n"  # bare page numbers are dropped


def test_a_document_answers_from_the_quick_pass_until_the_full_one_replaces_it(client: TestClient, pdf_bytes: bytes, parser: GatedParser) -> None:
    digest = upload(client, pdf_bytes)
    d = wait_doc(client, digest, lambda d: d["status"] == "ready")
    assert d["index"] == "quick" and d["refining"] is True and d["error"] is None
    assert all(c["id"].startswith(f"{digest}:q") for c in chunk_items(client, digest))
    hits = client.post(f"/api/ai/documents/{digest}/search", json={"query": "quarterly roadmap archipelago", "limit": 3}).json()["hits"]
    assert hits and "quarterly roadmap" in hits[0]["text"]
    assert client.get(f"/api/ai/documents/{digest}/sections").json() == []

    # While the full pass reads, the document stays ready and reports its progress.
    d = wait_doc(client, digest, lambda d: d["detail"] == "Reading page 1 of 2")
    assert d["status"] == "ready" and d["refining"]

    parser.gate.set()
    d = wait_doc(client, digest, lambda d: d["index"] == "full")
    assert d["status"] == "ready" and d["refining"] is False and d["detail"] is None and d["progress"] == 1.0
    items = chunk_items(client, digest)
    assert items and all(c["id"].startswith(f"{digest}:c") for c in items)
    assert [s["title"] for s in client.get(f"/api/ai/documents/{digest}/sections").json()][:2] == ["Lanterns and Light", "1 Introduction"]
    assert parser.calls == 1


def test_status_events_follow_a_refining_document_until_the_full_pass(client: TestClient, pdf_bytes: bytes, parser: GatedParser) -> None:
    digest = upload(client, pdf_bytes)
    wait_doc(client, digest, lambda d: d["status"] == "ready")
    seen: list[dict[str, Any]] = []
    with client.stream("GET", f"/api/ai/documents/{digest}/events") as r:
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            seen.append(json.loads(line[5:]))
            if len(seen) == 1:
                assert seen[0]["refining"] is True
                parser.gate.set()
    assert seen[-1]["index"] == "full" and seen[-1]["refining"] is False


def test_a_failed_full_pass_leaves_the_quick_passages_and_can_be_retried(client: TestClient, pdf_bytes: bytes, parser: GatedParser) -> None:
    parser.fail_with = IngestionError("The PDF couldn't be read (layout model crashed).")
    digest = upload(client, pdf_bytes)
    wait_doc(client, digest, lambda d: d["status"] == "ready")
    parser.gate.set()
    d = wait_doc(client, digest, lambda d: d["error"] is not None)
    assert d["status"] == "ready" and d["index"] == "quick" and d["refining"] is False
    assert "layout model crashed" in d["error"]
    assert client.post(f"/api/ai/documents/{digest}/search", json={"query": "roadmap"}).json()["hits"]

    parser.fail_with = None
    r = client.post(f"/api/ai/documents/{digest}/retry")
    assert r.status_code == 202 and r.json()["status"] == "ready" and r.json()["refining"] is True
    d = wait_doc(client, digest, lambda d: d["index"] == "full")
    assert d["status"] == "ready" and d["error"] is None


def test_a_pdf_without_a_text_layer_skips_the_quick_pass(client: TestClient, parser: GatedParser) -> None:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument.new()
    pdf.new_page(612, 792)
    buf = io.BytesIO()
    pdf.save(buf)
    pdf.close()
    digest = upload(client, buf.getvalue())
    wait_doc(client, digest, lambda d: d["status"] == "parsing" and d["detail"] == "Reading page 1 of 2")
    parser.gate.set()  # the stand-in parser "finds" text, so the full pass succeeds
    d = wait_doc(client, digest, lambda d: d["status"] == "ready")
    assert d["index"] == "full"


def test_a_running_preparation_cant_be_deleted(client: TestClient, pdf_bytes: bytes, parser: GatedParser) -> None:
    digest = upload(client, pdf_bytes)
    wait_doc(client, digest, lambda d: d["detail"] == "Reading page 1 of 2")
    assert client.delete(f"/api/ai/documents/{digest}").status_code == 409
    parser.gate.set()
    wait_doc(client, digest, lambda d: d["index"] == "full")
    assert client.delete(f"/api/ai/documents/{digest}").status_code == 204
