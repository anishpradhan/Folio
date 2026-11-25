import hashlib
import json
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from folio_ai.app import create_app
from folio_ai.config import Settings
from folio_ai.db import Database, IngestionJob, JobStatus
from folio_ai.ingestion import worker as worker_mod
from folio_ai.ingestion.pipeline import IngestionError
from folio_ai.ingestion.worker import recover
from folio_ai.services import Services
from tests.conftest import FakeEmbedder, FakeParser, wait_for


@pytest.fixture
def parser() -> FakeParser:
    return FakeParser()


@pytest.fixture
def client(settings: Settings, services: Services, parser: FakeParser, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(worker_mod, "RETRY_BACKOFF_S", (0, 0, 0))
    app = create_app(settings, parser=parser, services=services)
    with TestClient(app) as c:
        app.state.rt.worker.poll_s = 0.05
        yield c


def upload(client: TestClient, data: bytes, **form: Any):
    return client.post("/api/ai/documents", files={"file": ("paper.pdf", data, "application/pdf")}, data={"title": "Lanterns", **form})


def wait_status(client: TestClient, doc_id: str, *statuses: str) -> dict[str, Any]:
    out: dict[str, Any] = {}

    def done() -> bool:
        out.update(client.get(f"/api/ai/documents/{doc_id}").json())
        return out["status"] in statuses

    wait_for(done)
    return out


def jobs(settings: Settings, doc_id: str) -> list[IngestionJob]:
    db = Database(settings.db_url)
    try:
        with db.session() as s:
            return list(s.scalars(select(IngestionJob).where(IngestionJob.document_id == doc_id).order_by(IngestionJob.created_at)))
    finally:
        db.engine.dispose()


def test_upload_ingest_inspect_and_search(client: TestClient, pdf_bytes: bytes, parser: FakeParser) -> None:
    digest = hashlib.sha256(pdf_bytes).hexdigest()
    r = upload(client, pdf_bytes, sha256=digest)
    assert r.status_code == 202
    body = r.json()
    assert body["id"] == digest and body["status"] in ("queued", "parsing", "chunking", "embedding", "indexing", "ready")

    doc = wait_status(client, digest, "ready", "failed")
    assert doc["status"] == "ready", doc
    assert doc["pageCount"] == 2 and doc["chunkCount"] >= 3 and doc["embeddingModel"] == "fake-embed-64"
    # The document turns ready a moment before the worker closes its job.
    wait_for(lambda: client.get(f"/api/ai/documents/{digest}").json()["job"]["status"] == "succeeded")

    sections = client.get(f"/api/ai/documents/{digest}/sections").json()
    assert [s["title"] for s in sections][:3] == ["Lanterns and Light", "1 Introduction", "2 Method"]
    chunks = client.get(f"/api/ai/documents/{digest}/chunks").json()
    assert chunks["total"] == doc["chunkCount"]
    assert all(c["locations"] and c["pageStart"] >= 1 for c in chunks["items"])

    hits = client.post(f"/api/ai/documents/{digest}/search", json={"query": "photometer calibrated against a standard candle", "limit": 3}).json()["hits"]
    assert "standard candle" in hits[0]["text"]
    assert hits[0]["headingPath"] == ["2 Method", "2.1 Calibration"] and hits[0]["pageStart"] == 1
    for mode in ("dense", "bm25"):
        top = client.post(f"/api/ai/documents/{digest}/search", json={"query": "paraffin lamps brighter after trimming", "mode": mode}).json()["hits"][0]
        assert "forty percent" in top["text"], mode

    # Section-scoped retrieval only returns passages inside that section (and its subsections).
    method = next(s for s in sections if s["title"] == "2 Method")
    scoped = client.post(f"/api/ai/documents/{digest}/search", json={"query": "lantern wick trimmed", "section_id": method["id"]}).json()["hits"]
    assert scoped and all(h["headingPath"][0] == "2 Method" for h in scoped)
    # Page-range scope.
    p2 = client.post(f"/api/ai/documents/{digest}/search", json={"query": "lamps", "page_start": 2, "page_end": 2}).json()["hits"]
    assert p2 and all(h["pageStart"] <= 2 <= h["pageEnd"] for h in p2)

    # The same bytes again (e.g. from the tablet): no new work.
    again = upload(client, pdf_bytes)
    assert again.status_code == 200 and again.json()["status"] == "ready"
    assert parser.calls == 1


def test_upload_validation(client: TestClient, pdf_bytes: bytes) -> None:
    assert upload(client, b"PK\x03\x04 not a pdf").status_code == 415
    assert upload(client, b"").status_code == 400
    r = upload(client, pdf_bytes, sha256="0" * 64)
    assert r.status_code == 400 and "intact" in r.json()["detail"]
    assert client.get("/api/ai/documents/not-a-hash").status_code == 400
    assert client.get(f"/api/ai/documents/{'f' * 64}").status_code == 404


def test_permanent_failure_then_manual_retry(client: TestClient, pdf_bytes: bytes, parser: FakeParser, settings: Settings) -> None:
    parser.fail_with = IngestionError("This PDF is password-protected, so it can't be read.")
    digest = upload(client, pdf_bytes).json()["id"]
    doc = wait_status(client, digest, "failed")
    assert doc["error"] == "This PDF is password-protected, so it can't be read."
    assert doc["job"]["errorKind"] == "permanent"
    assert len(jobs(settings, digest)) == 1  # permanent errors are not retried automatically

    parser.fail_with = None
    r = client.post(f"/api/ai/documents/{digest}/retry")
    assert r.status_code == 202
    assert wait_status(client, digest, "ready", "failed")["status"] == "ready"
    assert [j.attempt for j in jobs(settings, digest)] == [1, 1]
    assert client.post(f"/api/ai/documents/{digest}/retry").status_code == 409  # already ready
    assert client.post(f"/api/ai/documents/{digest}/retry?force=true").status_code == 202
    wait_status(client, digest, "ready")
    assert parser.calls == 3  # force re-parses


def test_transient_failures_retry_automatically(client: TestClient, pdf_bytes: bytes, fake_embedder: FakeEmbedder, parser: FakeParser, settings: Settings) -> None:
    fake_embedder.fail_times = 2
    digest = upload(client, pdf_bytes).json()["id"]
    assert wait_status(client, digest, "ready", "failed")["status"] == "ready"
    js = jobs(settings, digest)
    assert [(j.attempt, j.status, j.error_kind) for j in js] == [(1, "failed", "transient"), (2, "failed", "transient"), (3, "succeeded", None)]
    assert parser.calls == 1  # the parse is cached; retries only redo the failed stages


def test_transient_failures_give_up_after_the_limit(client: TestClient, pdf_bytes: bytes, fake_embedder: FakeEmbedder, settings: Settings) -> None:
    fake_embedder.fail_times = 99
    digest = upload(client, pdf_bytes).json()["id"]
    doc = wait_status(client, digest, "failed")
    assert "Embedding provider unavailable" in doc["error"]
    assert len(jobs(settings, digest)) == settings.max_auto_retries + 1


def test_status_events_stream_until_ready(client: TestClient, pdf_bytes: bytes, parser: FakeParser) -> None:
    parser.delay = 0.6
    digest = upload(client, pdf_bytes).json()["id"]
    seen: list[str] = []
    with client.stream("GET", f"/api/ai/documents/{digest}/events") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        event = None
        for line in r.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:") and event == "status":
                seen.append(json.loads(line[5:])["status"])
    assert seen[-1] == "ready"
    assert "parsing" in seen and seen.index("parsing") < seen.index("ready")


def test_delete_removes_everything(client: TestClient, pdf_bytes: bytes, settings: Settings, services: Services) -> None:
    digest = upload(client, pdf_bytes).json()["id"]
    wait_status(client, digest, "ready")
    assert services.store.count(digest) > 0
    assert client.delete(f"/api/ai/documents/{digest}").status_code == 204
    assert client.get(f"/api/ai/documents/{digest}").status_code == 404
    assert services.store.count(digest) == 0
    assert not (settings.files_dir / f"{digest}.pdf").exists()
    assert not list(settings.parsed_dir.glob(f"{digest}.*"))


def test_health_never_reveals_keys(client: TestClient) -> None:
    h = client.get("/api/ai/health").json()
    assert h["ok"] and h["worker"] and h["embedding"]["provider"] == "local"
    assert "key" not in json.dumps(h).lower()


def test_recover_requeues_interrupted_jobs(settings: Settings) -> None:
    from folio_ai.db import Document

    db = Database(settings.db_url)
    with db.session() as s:
        s.add(Document(id="e" * 64, format="pdf", file_size=1, status="embedding"))
        s.add(IngestionJob(id="j1", document_id="e" * 64, status=JobStatus.RUNNING))
    assert recover(db) == 1
    with db.session() as s:
        assert s.get(IngestionJob, "j1").status == JobStatus.QUEUED  # type: ignore[union-attr]
        assert s.get(Document, "e" * 64).status == "queued"  # type: ignore[union-attr]
    db.engine.dispose()


def test_damaged_pdf_fails_with_a_readable_message(client: TestClient, parser: FakeParser) -> None:
    digest = upload(client, b"%PDF-1.7\nthis is not really a pdf").json()["id"]
    doc = wait_status(client, digest, "failed")
    assert doc["error"] == "This file isn't a readable PDF (it may be damaged)."
    assert parser.calls == 0  # caught before the expensive parse
