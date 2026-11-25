"""The Claude provider against a local stand-in for the Messages API: checks the request we send and how the
real SDK's stream events (thinking, text, citations) become provider events. No network, no key."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Iterator

import anthropic
import pytest

from folio_ai.config import Settings
from folio_ai.llm import Citation, Finished, LLMError, SourceDoc, SpanEnd, TextDelta, Thinking, Turn
from folio_ai.llm.claude import ClaudeProvider


def sse(*events: dict[str, Any]) -> bytes:
    return b"".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode() for e in events)


STREAM = sse(
    {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 812, "output_tokens": 1}}},
    {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}},
    {"type": "content_block_stop", "index": 0},
    {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": "", "citations": []}},
    {"type": "content_block_delta", "index": 1, "delta": {"type": "citations_delta", "citation": {"type": "content_block_location", "cited_text": "Paraffin lamps were forty percent brighter.", "document_index": 0, "document_title": "3 Results", "start_block_index": 1, "end_block_index": 2}}},
    {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "They were 40% brighter."}},
    {"type": "content_block_stop", "index": 1},
    {"type": "content_block_start", "index": 2, "content_block": {"type": "text", "text": "", "citations": None}},
    {"type": "content_block_delta", "index": 2, "delta": {"type": "text_delta", "text": " Nothing else is reported."}},
    {"type": "content_block_stop", "index": 2},
    {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 31}},
    {"type": "message_stop"},
)


class StandIn:
    """A one-route HTTP server: records request bodies and headers, replies with a canned response."""

    def __init__(self) -> None:
        self.requests: list[tuple[dict[str, str], dict[str, Any]]] = []
        self.reply: tuple[int, str, bytes] = (200, "text/event-stream", STREAM)
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                outer.requests.append(({k.lower(): v for k, v in self.headers.items()}, body))
                status, ctype, payload = outer.reply
                self.send_response(status)
                self.send_header("content-type", ctype)
                self.send_header("request-id", "req_test")
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


def provider(standin: StandIn, **settings: Any) -> ClaudeProvider:
    st = Settings(_env_file=None, anthropic_api_key="test-key", **settings)
    return ClaudeProvider(st, client=anthropic.Anthropic(api_key="test-key", base_url=standin.url, max_retries=0))


SOURCES = [SourceDoc(title="3 Results", blocks=["We measured lamps.", "Paraffin lamps were forty percent brighter."], context='From "Lanterns", p. 2')]


def test_stream_answer_request_and_events(standin: StandIn) -> None:
    events = list(
        provider(standin).stream_answer(
            system="SYSTEM", history=[Turn("user", "Earlier?"), Turn("assistant", "Earlier answer.")], sources=SOURCES, prompt="How much brighter?", effort="medium"
        )
    )
    assert events == [
        Thinking(),
        Citation(0, 1, 2, "Paraffin lamps were forty percent brighter."),
        TextDelta("They were 40% brighter."),
        SpanEnd(),
        TextDelta(" Nothing else is reported."),
        SpanEnd(),
        Finished("end_turn", "claude-opus-5-5", events[-1].usage),
    ]
    assert events[-1].usage["output_tokens"] == 31 and events[-1].usage["input_tokens"] == 812

    headers, body = standin.requests[0]
    assert headers["authorization"] == "Bearer test-key" and "server-side-fallback-2026-07-01" in headers["anthropic-beta"]
    assert body["model"] == "claude-opus-5-5" and body["stream"] is True and body["system"] == "SYSTEM"
    assert body["fallbacks"] == "default" and body["output_config"] == {"effort": "medium"}
    assert "thinking" not in body and "temperature" not in body  # adaptive by default on Opus 5.5
    assert body["messages"][:2] == [{"role": "user", "content": "Earlier?"}, {"role": "assistant", "content": "Earlier answer."}]
    doc, question = body["messages"][2]["content"]
    assert doc == {
        "type": "document",
        "source": {"type": "content", "content": [{"type": "text", "text": "We measured lamps."}, {"type": "text", "text": "Paraffin lamps were forty percent brighter."}]},
        "title": "3 Results",
        "citations": {"enabled": True},
        "context": 'From "Lanterns", p. 2',
    }
    assert question == {"type": "text", "text": "How much brighter?"}


def test_fallbacks_can_be_turned_off(standin: StandIn) -> None:
    list(provider(standin, llm_fallbacks=False).stream_answer(system="S", history=[], sources=SOURCES, prompt="q", effort="low"))
    headers, body = standin.requests[0]
    assert "fallbacks" not in body and "server-side-fallback" not in headers.get("anthropic-beta", "")


@pytest.mark.parametrize(
    ("status", "message", "retryable"),
    [
        (401, "API key was rejected", False),
        (404, "model wasn't found", False),
        (429, "rate-limited", True),
        (529, "temporarily unavailable", True),
    ],
)
def test_api_errors_become_reader_facing_messages(standin: StandIn, status: int, message: str, retryable: bool) -> None:
    standin.reply = (status, "application/json", json.dumps({"type": "error", "error": {"type": "x", "message": "secret detail"}}).encode())
    with pytest.raises(LLMError) as e:
        list(provider(standin).stream_answer(system="S", history=[], sources=SOURCES, prompt="q", effort="low"))
    assert message in str(e.value) and e.value.retryable is retryable and "secret" not in str(e.value)


def test_bad_request_passes_on_the_apis_explanation(standin: StandIn) -> None:
    msg = "Your credit balance is too low to access the Anthropic API."
    standin.reply = (400, "application/json", json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": msg}}).encode())
    with pytest.raises(LLMError) as e:
        list(provider(standin).stream_answer(system="S", history=[], sources=SOURCES, prompt="q", effort="low"))
    assert str(e.value) == f"The assistant service rejected the request: {msg}" and e.value.retryable is False


def test_complete_returns_text(standin: StandIn) -> None:
    standin.reply = (
        200,
        "application/json",
        json.dumps(
            {"id": "m", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 5, "output_tokens": 5},
             "content": [{"type": "thinking", "thinking": "", "signature": "s"}, {"type": "text", "text": "  How was the photometer calibrated?  "}]}
        ).encode(),
    )
    out = provider(standin).complete(system="S", prompt="P", effort="low", max_tokens=2048)
    assert out == "How was the photometer calibrated?"
    _, body = standin.requests[0]
    assert body["output_config"] == {"effort": "low"} and body["max_tokens"] == 2048 and "stream" not in body
