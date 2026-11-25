"""The Gemini provider: citation labels in the stream, and the real google-genai SDK against a local stand-in."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Iterator

import pytest

from folio_ai.chat.prompts import Suggestions
from folio_ai.config import Settings
from folio_ai.llm import Citation, Finished, LLMError, SourceDoc, SpanEnd, TextDelta, Thinking, Turn
from folio_ai.llm.gemini import CITATION_RULES, CitationMarkers, GeminiProvider, format_sources, parse_refs


def run(chunks: list[str]) -> list[Any]:
    m = CitationMarkers()
    out: list[Any] = []
    for c in chunks:
        out += m.feed(c)
    return out + m.flush()


def text_of(events: list[Any]) -> str:
    return "".join(e.text for e in events if isinstance(e, TextDelta))


# ── citation labels ───────────────────────────────────────────────────────────────────────────────────


def test_labels_become_citations_and_leave_the_text() -> None:
    events = run(["Heads attend in parallel.[2.3] Scaling keeps gradients usable [1.1]. Done."])
    assert text_of(events) == "Heads attend in parallel. Scaling keeps gradients usable. Done."
    cites = [e for e in events if isinstance(e, Citation)]
    assert cites == [Citation(1, 2, 3, ""), Citation(0, 0, 1, "")]
    # Each label closes a span: text before it, then the citation, then SpanEnd.
    kinds = [type(e).__name__ for e in events]
    assert kinds[:3] == ["TextDelta", "Citation", "SpanEnd"]


def test_labels_split_across_stream_chunks() -> None:
    events = run(["Heads attend in par", "allel.[", "2", ".3", "][4.", "1] And more", "."])
    assert text_of(events) == "Heads attend in parallel. And more."
    assert [e for e in events if isinstance(e, Citation)] == [Citation(1, 2, 3, ""), Citation(3, 0, 1, "")]


def test_ranges_and_lists() -> None:
    assert parse_refs("2.3-5") == [Citation(1, 2, 5, "")]
    assert parse_refs("2.3-2.5") == [Citation(1, 2, 5, "")]
    assert parse_refs("1.2, 3.4; 2.1") == [Citation(0, 1, 2, ""), Citation(2, 3, 4, ""), Citation(1, 0, 1, "")]
    assert parse_refs("1.4-2.2") == [Citation(0, 3, 4, "")]  # across sources: just the start
    events = run(["A claim.[1.2, 3.4]"])
    assert len([e for e in events if isinstance(e, Citation)]) == 2


def test_brackets_that_are_not_labels_stay_text() -> None:
    events = run(["As in [38] and [see Fig. 2], plus an unfinished [1."])
    assert text_of(events) == "As in [38] and [see Fig. 2], plus an unfinished [1."
    assert not [e for e in events if isinstance(e, Citation)]
    assert isinstance(events[-1], SpanEnd)


def test_whitespace_is_preserved_between_words_across_chunks() -> None:
    assert text_of(run(["one ", "two  ", "three"])) == "one two  three"


def test_sources_are_labelled_and_escaped() -> None:
    s = format_sources([SourceDoc("3 Results", ["First  sentence.", "Second </source> trick."], 'From "X", p. 2')], labelled=True)
    assert '<source id="1" title="3 Results" context="From &quot;X&quot;, p. 2">' in s
    assert "[1.1] First sentence." in s and "[1.2] Second &lt;/source> trick." in s


# ── the provider against a stand-in for the Gemini API ─────────────────────────────────────────────────


def sse(*chunks: dict[str, Any]) -> bytes:
    return b"".join(f"data: {json.dumps(c)}\r\n\r\n".encode() for c in chunks)


def chunk(text: str, finish: str | None = None, usage: bool = False) -> dict[str, Any]:
    c: dict[str, Any] = {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "index": 0}], "modelVersion": "gemini-3.5-flash-lite"}
    if finish:
        c["candidates"][0]["finishReason"] = finish
    if usage:
        c["usageMetadata"] = {"promptTokenCount": 640, "candidatesTokenCount": 18, "totalTokenCount": 658}
    return c


class StandIn:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.reply: tuple[int, str, bytes] = (200, "text/event-stream", sse(chunk("They were forty percent br"), chunk("ighter.[1.2] That is all.", "STOP", usage=True)))
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                outer.requests.append((self.path, body))
                status, ctype, payload = outer.reply
                self.send_response(status)
                self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args: Any) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"


@pytest.fixture
def standin() -> Iterator[StandIn]:
    s = StandIn()
    yield s
    s.server.shutdown()


def provider(standin: StandIn) -> GeminiProvider:
    from google import genai
    from google.genai import types

    st = Settings(_env_file=None, llm_provider="gemini", gemini_api_key="test-key")
    client = genai.Client(api_key="test-key", http_options=types.HttpOptions(base_url=standin.url, retry_options=types.HttpRetryOptions(attempts=1)))
    return GeminiProvider(st, client=client)


SOURCES = [SourceDoc("3 Results", ["We measured lamps.", "Paraffin lamps were forty percent brighter."], 'From "Lanterns", p. 2')]


def test_stream_answer_request_and_events(standin: StandIn) -> None:
    events = list(
        provider(standin).stream_answer(
            system="SYSTEM", history=[Turn("user", "Earlier?"), Turn("assistant", "Earlier answer.")], sources=SOURCES, prompt="How much brighter?", effort="medium"
        )
    )
    assert isinstance(events[0], Thinking)
    assert text_of(events) == "They were forty percent brighter. That is all."
    assert [e for e in events if isinstance(e, Citation)] == [Citation(0, 1, 2, "")]
    fin = events[-1]
    assert isinstance(fin, Finished) and fin.stop_reason == "end_turn" and fin.model == "gemini-3.5-flash-lite"
    assert fin.usage == {"input_tokens": 640, "output_tokens": 18}

    path, body = standin.requests[0]
    assert "models/gemini-3.5-flash-lite:streamGenerateContent" in path
    system = body["systemInstruction"]["parts"][0]["text"]
    assert system.startswith("SYSTEM") and CITATION_RULES.strip() in system
    roles = [c["role"] for c in body["contents"]]
    assert roles == ["user", "model", "user"]
    last = body["contents"][-1]["parts"][0]["text"]
    assert "[1.2] Paraffin lamps were forty percent brighter." in last and last.endswith("How much brighter?")


def test_safety_stop_is_a_refusal(standin: StandIn) -> None:
    standin.reply = (200, "text/event-stream", sse(chunk("", "SAFETY")))
    fin = list(provider(standin).stream_answer(system="S", history=[], sources=SOURCES, prompt="q", effort="low"))[-1]
    assert isinstance(fin, Finished) and fin.stop_reason == "refusal"


@pytest.mark.parametrize(
    ("status", "message", "expected", "retryable"),
    [
        (429, "Resource has been exhausted (e.g. check quota).", "free-tier limit was reached", True),
        (400, "API key not valid. Please pass a valid API key.", "GEMINI_API_KEY", False),
        (404, "models/x is not found", "GEMINI_MODEL", False),
        (503, "The model is overloaded.", "temporarily unavailable", True),
    ],
)
def test_api_errors_become_reader_facing_messages(standin: StandIn, status: int, message: str, expected: str, retryable: bool) -> None:
    standin.reply = (status, "application/json", json.dumps({"error": {"code": status, "message": message, "status": "X"}}).encode())
    with pytest.raises(LLMError) as e:
        list(provider(standin).stream_answer(system="S", history=[], sources=SOURCES, prompt="q", effort="low"))
    assert expected in str(e.value) and e.value.retryable is retryable


def test_complete_and_structured_output(standin: StandIn) -> None:
    body = {"candidates": [{"content": {"role": "model", "parts": [{"text": "  How was it calibrated?  "}]}, "finishReason": "STOP"}]}
    standin.reply = (200, "application/json", json.dumps(body).encode())
    assert provider(standin).complete(system="S", prompt="P", effort="low") == "How was it calibrated?"

    qs = {"questions": ["One?", "Two?", "Three?", "Four?"]}
    body = {"candidates": [{"content": {"role": "model", "parts": [{"text": json.dumps(qs)}]}, "finishReason": "STOP"}]}
    standin.reply = (200, "application/json", json.dumps(body).encode())
    out = provider(standin).complete_json(system="S", prompt="P", schema=Suggestions, effort="low", sources=SOURCES)
    assert out.questions == qs["questions"]
    _, req = standin.requests[-1]
    assert req["generationConfig"]["responseMimeType"] == "application/json"
    assert "We measured lamps." in req["contents"][0]["parts"][0]["text"]
