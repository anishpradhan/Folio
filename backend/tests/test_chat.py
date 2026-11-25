"""Phase 3: generation and chat — streamed answers, citation resolution, follow-ups, modes, failures, storage."""

import hashlib
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from folio_ai.chat import ChatService, TurnRequest
from folio_ai.chat.prompts import ANSWER_SYSTEM
from folio_ai.ingestion.chunking import citation_blocks
from folio_ai.llm import Citation, Finished, LLMError, SpanEnd, TextDelta
from folio_ai.services import Services
from folio_ai.textutil import split_sentences
from tests.conftest import FakeLLM
from tests.test_api import client, parser, upload, wait_status  # noqa: F401 — fixtures

QUESTION = "How much brighter were the paraffin lamps?"


@pytest.fixture
def doc(client: TestClient, pdf_bytes: bytes) -> str:  # noqa: F811
    digest = hashlib.sha256(pdf_bytes).hexdigest()
    upload(client, pdf_bytes, sha256=digest)
    assert wait_status(client, digest, "ready", "failed")["status"] == "ready"
    return digest


@pytest.fixture
def conv(client: TestClient, doc: str) -> str:  # noqa: F811
    r = client.post(f"/api/ai/documents/{doc}/conversations", json={})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def ask(client: TestClient, conv: str, **body: Any) -> list[tuple[str, Any]]:  # noqa: F811
    r = client.post(f"/api/ai/conversations/{conv}/messages", json=body)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    events = []
    for frame in r.text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in frame.splitlines())
        events.append((lines["event"], json.loads(lines["data"])))
    return events


def messages(client: TestClient, conv: str) -> list[dict[str, Any]]:  # noqa: F811
    return client.get(f"/api/ai/conversations/{conv}").json()["messages"]


def chunk_with(client: TestClient, doc: str, needle: str) -> dict[str, Any]:  # noqa: F811
    return next(c for c in client.get(f"/api/ai/documents/{doc}/chunks").json()["items"] if needle in c["text"])


# ── citation blocks (ingestion) ─────────────────────────────────────────────────────────────────────────


def test_citation_blocks_follow_the_items_they_came_from() -> None:
    a = [{"page": 1, "rect": {"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.1}}]
    b = [{"page": 2, "rect": {"x": 0.1, "y": 0.2, "w": 0.8, "h": 0.1}}]
    body = "The first paragraph has one sentence that is long enough.\nThe second one is on page two. It has a second sentence, also long enough."
    blocks = citation_blocks(body, ["The first paragraph has one sentence that is long enough.", "The second one is on page two. It has a second sentence, also long enough."], [a, b], a)
    # "The second one is on page two." is under 40 characters, so it is merged with the next sentence.
    assert [x["text"] for x in blocks] == [
        "The first paragraph has one sentence that is long enough.",
        "The second one is on page two. It has a second sentence, also long enough.",
    ]
    assert blocks[0]["locations"] == a and blocks[1]["locations"] == b
    # Unmatched lines (e.g. a flattened table) keep the current item's boxes.
    assert citation_blocks("| a | b | c | d |", [""], [b], a)[0]["locations"] == b


def test_split_sentences_keeps_abbreviations_and_merges_fragments() -> None:
    s = split_sentences("As shown by Vaswani et al. (2017), attention works well. See Fig. 2. A final sentence that is long enough to stand alone.")
    assert s == ["As shown by Vaswani et al. (2017), attention works well.", "See Fig. 2. A final sentence that is long enough to stand alone."]


def test_ingested_chunks_carry_citation_blocks(client: TestClient, doc: str, settings: Any) -> None:  # noqa: F811
    from folio_ai.db import Chunk, Database

    db = Database(settings.db_url)
    try:
        with db.session() as s:
            rows = s.query(Chunk).filter(Chunk.document_id == doc).all()
            assert rows and all(c.blocks for c in rows)
            for c in rows:
                assert " ".join(b["text"] for b in c.blocks).replace(" ", "") == c.text.replace("\n", "").replace(" ", "")
                assert all(b["locations"] and b["locations"][0]["page"] in (1, 2) for b in c.blocks)
    finally:
        db.engine.dispose()


# ── a chat turn ─────────────────────────────────────────────────────────────────────────────────────────


def test_answer_streams_with_resolved_citations_and_is_stored(client: TestClient, doc: str, conv: str, fake_llm: FakeLLM) -> None:  # noqa: F811
    events = ask(client, conv, content=QUESTION)
    names = [e for e, _ in events]
    assert names == ["start", "sources", "status", "delta", "delta", "citation", "delta", "done"]
    sources = events[1][1]
    assert sources and [s["n"] for s in sources] == list(range(1, len(sources) + 1))

    cit = events[5][1]
    first_source_doc = fake_llm.calls[0]["sources"][0]
    assert cit["id"] == 1 and cit["source"] == 1 and (cit["start"], cit["end"]) == (0, len("Lamps were brighter."))
    assert cit["quote"] == first_source_doc.blocks[0] and cit["chunkId"].startswith(doc)
    assert cit["page"] in (1, 2) and cit["locations"][0]["rect"]["w"] > 0
    assert cit["headingPath"] == sources[0]["headingPath"]

    done = events[-1][1]
    assert done["status"] == "complete" and done["model"] == "fake-llm" and done["usage"]["output_tokens"] == 9

    call = fake_llm.calls[0]
    assert call["system"] == ANSWER_SYSTEM and call["prompt"] == QUESTION and call["history"] == [] and call["effort"] == "medium"
    assert first_source_doc.title == " > ".join(sources[0]["headingPath"]) and "Lanterns" in (first_source_doc.context or "")

    stored = messages(client, conv)
    assert [m["role"] for m in stored] == ["user", "assistant"]
    user, answer = stored
    assert user["content"] == QUESTION and user["mode"] == "chat"
    assert answer["content"] == "Lamps were brighter. That is all." and answer["status"] == "complete"
    assert answer["citations"] == [cit] and answer["model"] == "fake-llm"
    assert answer["retrieval"]["query"] == QUESTION and answer["retrieval"]["rewritten"] is False
    assert answer["retrieval"]["passages"] and answer["retrieval"]["droppedCitations"] == 0
    conv_list = client.get(f"/api/ai/documents/{doc}/conversations").json()
    assert conv_list[0]["title"] == QUESTION and conv_list[0]["messageCount"] == 2


def test_follow_up_is_rewritten_for_search_and_sees_history(client: TestClient, conv: str, fake_llm: FakeLLM) -> None:  # noqa: F811
    ask(client, conv, content=QUESTION)
    ask(client, conv, content="And how was the photometer checked?")
    assert len(fake_llm.completions) == 1
    rewrite = fake_llm.completions[0]
    assert f"Reader: {QUESTION}" in rewrite and "Assistant: Lamps were brighter. That is all." in rewrite
    assert rewrite.endswith("Follow-up question: And how was the photometer checked?")
    hist = fake_llm.calls[1]["history"]
    assert [(t.role, t.text) for t in hist] == [("user", QUESTION), ("assistant", "Lamps were brighter. That is all.")]
    second = messages(client, conv)[-1]
    assert second["retrieval"]["query"] == "STANDALONE And how was the photometer checked?" and second["retrieval"]["rewritten"] is True


def test_citations_outside_the_provided_sources_are_dropped(client: TestClient, conv: str, fake_llm: FakeLLM) -> None:  # noqa: F811
    fake_llm.script = lambda sources, prompt: [
        TextDelta("Made up."),
        Citation(99, 0, 1, "not a source"),
        Citation(0, 10_000, 10_001, "not a block"),
        SpanEnd(),
        Finished("end_turn", "fake-llm"),
    ]
    events = ask(client, conv, content=QUESTION)
    assert "citation" not in [e for e, _ in events]
    assert messages(client, conv)[-1]["retrieval"]["droppedCitations"] == 2


def test_a_citation_spanning_blocks_merges_their_locations(client: TestClient, conv: str, fake_llm: FakeLLM) -> None:  # noqa: F811
    fake_llm.script = lambda sources, prompt: [TextDelta("x"), Citation(0, 0, 50, ""), SpanEnd(), Finished("end_turn", "fake-llm")]
    cit = next(d for e, d in ask(client, conv, content=QUESTION) if e == "citation")
    blocks = fake_llm.calls[0]["sources"][0].blocks
    assert cit["quote"] == " ".join(blocks)  # empty quote → the cited blocks' text; range clamped to the source
    assert len(cit["locations"]) == len({json.dumps(x, sort_keys=True) for x in cit["locations"]})


# ── selection modes ─────────────────────────────────────────────────────────────────────────────────────


def test_explain_uses_the_selection_and_its_neighbours_without_retrieval(client: TestClient, doc: str, conv: str, fake_llm: FakeLLM, fake_reranker: Any) -> None:  # noqa: F811
    target = chunk_with(client, doc, "standard candle")
    sel = "The photometer was calibrated against a standard candle"
    events = ask(client, conv, mode="explain", selection={"text": sel, "page": 1})
    assert events[-1][0] == "done"
    call = fake_llm.calls[0]
    assert call["history"] == [] and call["prompt"].startswith("Explain the selected passage")
    assert sel in call["prompt"]
    sent_chunks = [cid for s in events[1][1] for cid in s["chunkIds"]]
    assert target["id"] in sent_chunks
    stored_user, stored_answer = messages(client, conv)
    assert stored_user["content"] == "Explain this passage" and stored_user["scope"]["selection"] == {"text": sel, "page": 1}
    assert stored_answer["retrieval"]["selection"] == {"match": "exact", "chunkId": target["id"]}
    assert "query" not in stored_answer["retrieval"]  # no search for explain/summarize/simplify
    assert client.get(f"/api/ai/conversations/{conv}").json()["title"].startswith("Explain this passage: The photometer")


def test_ask_about_a_selection_searches_its_section_first(client: TestClient, doc: str, conv: str, fake_llm: FakeLLM) -> None:  # noqa: F811
    target = chunk_with(client, doc, "standard candle")
    events = ask(client, conv, mode="ask", content="Why calibrate before each session?", selection={"text": "calibrated against a standard candle", "page": 1})
    assert events[-1][0] == "done"
    retrieval = messages(client, conv)[-1]["retrieval"]
    assert retrieval["selection"]["chunkId"] == target["id"]
    assert retrieval["scope"]["sectionId"] == target["sectionId"]
    assert target["id"] not in [p["chunkId"] for p in retrieval["passages"]]  # already the first source
    prompt = fake_llm.calls[0]["prompt"]
    assert prompt.startswith("Why calibrate before each session?") and "calibrated against a standard candle" in prompt


def test_unlocated_selection_is_still_a_source(client: TestClient, conv: str, fake_llm: FakeLLM) -> None:  # noqa: F811
    events = ask(client, conv, mode="summarize", selection={"text": "Figure 7: a diagram of a lighthouse lens with labelled prisms.", "page": 2})
    sources = events[1][1]
    assert sources[0]["headingPath"] == ["Selected text"] and sources[0]["pageStart"] == 2
    cit = next(d for e, d in events if e == "citation")
    assert cit["chunkId"] is None and cit["page"] == 2


# ── failures ──────────────────────────────────────────────────────────────────────────────────────────


def test_refusal_discards_the_partial_answer(client: TestClient, conv: str, fake_llm: FakeLLM) -> None:  # noqa: F811
    fake_llm.script = lambda s, p: [TextDelta("Partial"), SpanEnd(), Finished("refusal", "fake-llm")]
    events = ask(client, conv, content=QUESTION)
    assert events[-1] == ("error", {"message": "The assistant declined to answer this request.", "retryable": False, "messageId": events[-1][1]["messageId"]})
    answer = messages(client, conv)[-1]
    assert answer["status"] == "refused" and answer["content"] == "" and answer["citations"] == []


def test_provider_error_mid_stream_keeps_the_partial_and_is_left_out_of_history(client: TestClient, conv: str, fake_llm: FakeLLM) -> None:  # noqa: F811
    fake_llm.script = lambda s, p: [TextDelta("Half an"), LLMError("The assistant is rate-limited right now.", retryable=True)]
    events = ask(client, conv, content=QUESTION)
    assert events[-1][0] == "error" and events[-1][1]["retryable"] is True
    failed = messages(client, conv)[-1]
    assert failed["status"] == "error" and failed["content"] == "Half an"
    fake_llm.script = None
    ask(client, conv, content="Try again: how much brighter?")
    assert fake_llm.calls[-1]["history"] == []  # the failed pair isn't context for the model


def test_closing_the_stream_saves_an_interrupted_answer(client: TestClient, conv: str, services: Services) -> None:  # noqa: F811
    rt = client.app.state.rt
    gen = ChatService(rt.db, services, rt.settings).run(conv, TurnRequest(content=QUESTION))
    for event, _ in gen:
        if event == "delta":
            break
    gen.close()
    answer = messages(client, conv)[-1]
    assert answer["role"] == "assistant" and answer["status"] == "interrupted" and answer["content"] == "Lamps were "


def test_without_credentials_the_assistant_is_unavailable(client: TestClient, doc: str, conv: str, services: Services, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: F811
    import folio_ai.llm.claude as claude

    services._llm = None
    monkeypatch.setattr(claude, "has_credentials", lambda settings: False)
    r = client.post(f"/api/ai/conversations/{conv}/messages", json={"content": QUESTION})
    assert r.status_code == 503 and "ANTHROPIC_API_KEY" in r.json()["detail"]
    assert client.get(f"/api/ai/documents/{doc}/suggestions").status_code == 503
    health = client.get("/api/ai/health").json()
    assert health["llm"] == {"provider": "anthropic", "model": "claude-opus-5-5", "configured": False}
    assert "sk-" not in json.dumps(health)


def test_request_validation(client: TestClient, conv: str) -> None:  # noqa: F811
    post = lambda body: client.post(f"/api/ai/conversations/{conv}/messages", json=body).status_code  # noqa: E731
    assert post({"content": "  "}) == 422  # chat needs a question
    assert post({"mode": "explain"}) == 422  # selection modes need the selection
    assert post({"mode": "ask", "selection": {"text": "x"}}) == 422  # ask needs a question too
    assert post({"content": "x", "mode": "translate"}) == 422
    assert client.post("/api/ai/conversations/not-a-uuid/messages", json={"content": "x"}).status_code == 404
    assert client.post("/api/ai/conversations/00000000-0000-0000-0000-000000000000/messages", json={"content": "x"}).status_code == 404


# ── conversations and suggestions ─────────────────────────────────────────────────────────────────────


def test_suggestions_are_generated_once(client: TestClient, doc: str, fake_llm: FakeLLM) -> None:  # noqa: F811
    first = client.get(f"/api/ai/documents/{doc}/suggestions").json()["questions"]
    again = client.get(f"/api/ai/documents/{doc}/suggestions").json()["questions"]
    assert len(first) == 4 and first == again and fake_llm.json_calls == 1


def test_conversations_list_get_delete_and_cascade(client: TestClient, doc: str, conv: str) -> None:  # noqa: F811
    other = client.post(f"/api/ai/documents/{doc}/conversations", json={"title": "Notes on lamps"}).json()
    ask(client, conv, content=QUESTION)
    listed = client.get(f"/api/ai/documents/{doc}/conversations").json()
    assert [c["id"] for c in listed] == [conv, other["id"]]  # most recently active first
    assert client.delete(f"/api/ai/conversations/{other['id']}").status_code == 204
    assert client.get(f"/api/ai/conversations/{other['id']}").status_code == 404
    assert client.delete(f"/api/ai/documents/{doc}").status_code in (200, 204)
    assert client.get(f"/api/ai/documents/{doc}/conversations").json() == []
    assert client.get(f"/api/ai/conversations/{conv}").status_code == 404
