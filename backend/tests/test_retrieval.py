"""Phase 2: retrieval layer — reranking, selection lookup, related passages and context assembly."""

import hashlib
from typing import Any

import pytest
from fastapi.testclient import TestClient

from folio_ai.retrieval import assemble_context
from folio_ai.retrieval.locate import normalise
from folio_ai.retrieval.retriever import Passage
from folio_ai.services import Services
from tests.conftest import FakeReranker
from tests.test_api import client, parser, upload, wait_status  # noqa: F401 — fixtures

pytestmark = pytest.mark.usefixtures("client")


def passage(ordinal: int, section: str | None, tokens: int, page: int = 1, text: str | None = None) -> Passage:
    return Passage(
        id=f"c{ordinal}",
        ordinal=ordinal,
        section_id=section,
        heading_path=[section or ""],
        text=text or f"passage {ordinal}",
        embed_text=text or f"passage {ordinal}",
        page_start=page,
        page_end=page,
        locations=[{"page": page, "rect": {"x": 0.1, "y": 0.1 * ordinal, "w": 0.8, "h": 0.05}}],
        token_count=tokens,
    )


@pytest.fixture
def ready_doc(client: TestClient, pdf_bytes: bytes) -> str:  # noqa: F811
    digest = hashlib.sha256(pdf_bytes).hexdigest()
    upload(client, pdf_bytes, sha256=digest)
    assert wait_status(client, digest, "ready", "failed")["status"] == "ready"
    return digest


def post(client: TestClient, doc: str, path: str, **body: Any) -> dict[str, Any]:  # noqa: F811
    r = client.post(f"/api/ai/documents/{doc}/{path}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── context assembly (pure) ───────────────────────────────────────────────────────────────────────────


def test_context_restores_reading_order_and_merges_neighbours() -> None:
    # Retrieved by relevance: 5, 2, 3, 9. 2 and 3 are adjacent in the same section → one source.
    ctx = assemble_context([passage(5, "s2", 100), passage(2, "s1", 100), passage(3, "s1", 100), passage(9, "s3", 100, page=2)], 10_000)
    assert [s.chunk_ids for s in ctx.sources] == [["c2", "c3"], ["c5"], ["c9"]]
    assert [s.n for s in ctx.sources] == [1, 2, 3]
    assert [s.best_rank for s in ctx.sources] == [2, 1, 4]
    assert ctx.sources[0].text == "passage 2\n\npassage 3" and len(ctx.sources[0].locations) == 2
    assert ctx.sources[2].pages_label == "p. 2" and ctx.token_count == 400
    rendered = ctx.render()
    assert rendered.startswith("[1] s1 (p. 1)\npassage 2") and "\n\n[3] s3 (p. 2)\npassage 9" in rendered
    assert ctx.source(2).chunk_ids == ["c5"] and ctx.source(4) is None


def test_context_does_not_merge_across_sections_or_gaps() -> None:
    ctx = assemble_context([passage(1, "s1", 10), passage(2, "s2", 10), passage(4, "s2", 10)], 1000)
    assert [s.chunk_ids for s in ctx.sources] == [["c1"], ["c2"], ["c4"]]


def test_context_budget_skips_what_does_not_fit_but_keeps_smaller_later_passages() -> None:
    ctx = assemble_context([passage(1, "a", 300), passage(2, "b", 500), passage(3, "c", 150), passage(1, "a", 300)], 500)
    assert [s.chunk_ids for s in ctx.sources] == [["c1"], ["c3"]]
    assert ctx.omitted == ["c2"] and ctx.token_count == 450  # the duplicate c1 is ignored, not omitted
    # The most relevant passage is kept even when it alone exceeds the budget.
    assert [s.chunk_ids for s in assemble_context([passage(7, "a", 900)], 500).sources] == [["c7"]]


def test_normalise_ignores_hyphenation_ligatures_and_spacing() -> None:
    assert normalise("trans-\nduction  ﬁelds") == normalise("transduction fields") == "transductionfields"


# ── API ─────────────────────────────────────────────────────────────────────────────────────────────────


def test_search_reranks_on_request(client: TestClient, ready_doc: str, fake_reranker: FakeReranker) -> None:  # noqa: F811
    plain = post(client, ready_doc, "search", query="photometer calibrated against a standard candle", limit=3)
    assert plain["reranked"] is False and plain["reranker"] is None and not fake_reranker.calls  # off by default
    assert all(h["rerankScore"] is None and h["score"] == h["fusedScore"] for h in plain["hits"])

    res = post(client, ready_doc, "search", query="photometer calibrated against a standard candle", limit=3, rerank=True)
    assert res["reranked"] is True and res["reranker"] == "fake-rerank"
    hits = res["hits"]
    assert "standard candle" in hits[0]["text"] and [h["rank"] for h in hits] == [1, 2, 3]
    assert all(h["score"] == h["rerankScore"] for h in hits)
    assert [h["rerankScore"] for h in hits] == sorted((h["rerankScore"] for h in hits), reverse=True)
    # The cross-encoder saw more candidates than were returned.
    assert len(fake_reranker.calls) == 1 and fake_reranker.calls[0][1] > 3


def test_search_without_a_reranker_degrades_gracefully(client: TestClient, ready_doc: str, services: Services, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: F811
    import folio_ai.retrieval.reranker as rr

    def broken(*_: Any, **__: Any) -> None:
        raise RuntimeError("Failed to allocate memory for requested buffer")

    services._reranker = None
    monkeypatch.setattr(rr, "CrossEncoderReranker", broken)
    res = post(client, ready_doc, "search", query="paraffin lamps", rerank=True)
    assert res["reranked"] is False and res["hits"]
    assert services.get_reranker() is None  # not retried on every request


def test_related_finds_the_selection_and_excludes_it(client: TestClient, ready_doc: str) -> None:  # noqa: F811
    # As pdf.js might hand it over: a line-break hyphen and different spacing.
    sel = "The photo-\nmeter was calibrated against  a standard candle"
    res = post(client, ready_doc, "related", text=sel, page=1, limit=5)
    assert res["selection"]["match"] == "exact" and "standard candle" in res["selection"]["text"]
    own = res["selection"]["id"]
    assert res["hits"] and all(h["id"] != own for h in res["hits"])
    assert any("brightness of paraffin lamps with a photometer" in h["text"] for h in res["hits"])


def test_related_without_a_located_selection_still_searches(client: TestClient, ready_doc: str) -> None:  # noqa: F811
    res = post(client, ready_doc, "related", text="lighthouse beams over stormy seas at midnight", limit=3)
    assert res["selection"] is None and res["hits"]


def test_selection_spanning_two_passages_is_located_by_its_start(client: TestClient, ready_doc: str) -> None:  # noqa: F811
    chunks = client.get(f"/api/ai/documents/{ready_doc}/chunks").json()["items"]
    a = next(c for c in chunks if "brightness of paraffin" in c["text"])
    b = next(c for c in chunks if "standard candle" in c["text"])
    sel = a["text"][-70:] + " " + b["text"][:30]
    res = post(client, ready_doc, "related", text=sel, page=1)
    assert res["selection"]["id"] == a["id"] and res["selection"]["match"] == "start"
    # Mostly in the second passage → that one, matched by where the selection ends.
    sel = a["text"][-15:] + " " + b["text"][:60]
    res = post(client, ready_doc, "related", text=sel, page=1)
    assert res["selection"]["id"] == b["id"] and res["selection"]["match"] == "end"


def test_context_endpoint_numbers_sources(client: TestClient, ready_doc: str) -> None:  # noqa: F811
    res = post(client, ready_doc, "context", query="how bright were paraffin lamps after trimming the wick", limit=4, budget_tokens=1000)
    assert res["sources"] and [s["n"] for s in res["sources"]] == list(range(1, len(res["sources"]) + 1))
    ordinals_ok = all(s["pageStart"] >= 1 and s["chunkIds"] and s["locations"] for s in res["sources"])
    assert ordinals_ok and res["text"].startswith("[1] ")
    assert res["tokenCount"] == sum(s["tokenCount"] for s in res["sources"]) <= 1000


def test_retrieval_endpoints_require_a_ready_document(client: TestClient) -> None:  # noqa: F811
    missing = "0" * 64
    for path, body in (("search", {"query": "x"}), ("related", {"text": "x"}), ("context", {"query": "x"})):
        assert client.post(f"/api/ai/documents/{missing}/{path}", json=body).status_code == 409
    assert client.post("/api/ai/documents/not-a-hash/search", json={"query": "x"}).status_code == 400
    assert client.get("/api/ai/health").json()["reranker"] == {"model": "Xenova/ms-marco-MiniLM-L-6-v2", "default": False}


def test_each_passage_keeps_its_own_vector_when_embedded_in_length_order(ready_doc: str, services: Services, fake_embedder: Any) -> None:
    """Passages are embedded sorted by length (less padding); every stored vector must still be its passage's."""
    from sqlalchemy import select

    from folio_ai.db import Chunk

    with services_db(services) as s:
        rows = list(s.scalars(select(Chunk).where(Chunk.document_id == ready_doc).order_by(Chunk.ordinal)))
        texts = {c.id: c.embed_text for c in rows}
    lengths = [len(c) for c in texts.values()]
    assert lengths != sorted(lengths)  # reading order isn't length order, so embedding reordered them
    points, _ = services.store.client.scroll(services.store.collection, limit=100, with_vectors=True)
    assert len(points) == len(texts)
    for p in points:
        stored = p.vector["dense"]
        expected = fake_embedder._vec(texts[p.payload["chunk_id"]])
        assert stored == pytest.approx(expected, abs=1e-6)


def services_db(services: Services) -> Any:
    from folio_ai.db import Database

    return Database(services.settings.db_url).session()
