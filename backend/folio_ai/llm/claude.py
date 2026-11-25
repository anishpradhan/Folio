"""Claude implementation of LLMProvider (Anthropic Python SDK).

* Sources are `document` blocks with custom content (one text block per sentence) and citations enabled, so
  the API returns `content_block_location` citations whose quotes are verbatim source text.
* Server-side refusal fallbacks are on by default (`fallbacks: "default"`): a declined request is retried on
  a fallback model inside the same call and stream. LLM_FALLBACKS=false turns this off.
* Thinking is adaptive (always on for Claude Opus 5.5); depth is set per call with `effort`."""

from __future__ import annotations

import logging
from typing import Any, Iterator, Sequence

import anthropic

from ..config import Settings
from .base import Citation, Event, Finished, LLMError, SourceDoc, SpanEnd, T, TextDelta, Thinking, Turn

log = logging.getLogger("folio_ai.llm")

FALLBACK_BETA = "server-side-fallback-2026-07-01"
ANSWER_MAX_TOKENS = 64_000  # a ceiling, not a target; streaming keeps long answers safe from HTTP timeouts


def _documents(sources: Sequence[SourceDoc], *, citations: bool) -> list[dict[str, Any]]:
    docs = []
    for d in sources:
        blocks = [{"type": "text", "text": b} for b in d.blocks if b.strip()]
        doc: dict[str, Any] = {
            "type": "document",
            "source": {"type": "content", "content": blocks},
            "title": d.title,
            "citations": {"enabled": citations},
        }
        if d.context:
            doc["context"] = d.context
        docs.append(doc)
    return docs


def _usage(u: Any) -> dict[str, Any]:
    try:
        return {k: v for k, v in u.to_dict().items() if v is not None}
    except Exception:  # noqa: BLE001 - usage is informational
        return {}


def has_credentials(settings: Settings) -> bool:
    import os

    key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else ""
    return bool(key or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


class ClaudeProvider:
    def __init__(self, settings: Settings, client: anthropic.Anthropic | None = None):
        key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else None
        # Without a key in backend/.env the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN itself.
        self._client = client or (anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic())
        self.model = settings.llm_model
        self._extra: dict[str, Any] = {"betas": [FALLBACK_BETA], "fallbacks": "default"} if settings.llm_fallbacks else {}

    # Answers ----------------------------------------------------------------------------------------

    def stream_answer(
        self, *, system: str, history: Sequence[Turn], sources: Sequence[SourceDoc], prompt: str, effort: str
    ) -> Iterator[Event]:
        messages: list[dict[str, Any]] = [{"role": t.role, "content": t.text} for t in history]
        messages.append({"role": "user", "content": [*_documents(sources, citations=True), {"type": "text", "text": prompt}]})
        block_types: dict[int, str] = {}
        try:
            with self._client.beta.messages.stream(
                model=self.model,
                max_tokens=ANSWER_MAX_TOKENS,
                system=system,
                messages=messages,
                output_config={"effort": effort},
                **self._extra,
            ) as stream:
                for ev in stream:
                    if ev.type == "content_block_start":
                        kind = ev.content_block.type
                        block_types[ev.index] = kind
                        if kind == "thinking":
                            yield Thinking()
                    elif ev.type == "content_block_delta":
                        d = ev.delta
                        if d.type == "text_delta":
                            yield TextDelta(d.text)
                        elif d.type == "citations_delta" and d.citation.type == "content_block_location":
                            c = d.citation
                            yield Citation(c.document_index, c.start_block_index, c.end_block_index, c.cited_text)
                    elif ev.type == "content_block_stop" and block_types.get(ev.index) == "text":
                        yield SpanEnd()
                final = stream.get_final_message()
        except anthropic.APIError as e:
            raise _llm_error(e) from e
        yield Finished(final.stop_reason, final.model, _usage(final.usage))

    # Short completions ------------------------------------------------------------------------------

    def complete(self, *, system: str, prompt: str, effort: str, max_tokens: int = 2048) -> str:
        try:
            res = self._client.beta.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": prompt}],
                output_config={"effort": effort},
                **self._extra,
            )
        except anthropic.APIError as e:
            raise _llm_error(e) from e
        if res.stop_reason == "refusal":
            raise LLMError("The assistant declined this request.")
        return "".join(b.text for b in res.content if b.type == "text").strip()

    def complete_json(self, *, system: str, prompt: str, schema: type[T], effort: str, sources: Sequence[SourceDoc] = ()) -> T:
        content = [*_documents(sources, citations=False), {"type": "text", "text": prompt}]
        try:
            res = self._client.beta.messages.parse(
                model=self.model,
                max_tokens=4096,
                system=system,
                messages=[{"role": "user", "content": content}],
                output_format=schema,
                output_config={"effort": effort},
                **self._extra,
            )
        except anthropic.APIError as e:
            raise _llm_error(e) from e
        if res.stop_reason == "refusal" or res.parsed_output is None:
            raise LLMError("The assistant couldn't produce a structured answer for this request.")
        return res.parsed_output


def _api_message(e: anthropic.APIError) -> str:
    body = e.body if isinstance(e.body, dict) else {}
    err = body.get("error") if isinstance(body.get("error"), dict) else body
    msg = str(err.get("message") or "").strip() if isinstance(err, dict) else ""
    return msg[:300] or "no details were given."


def _llm_error(e: anthropic.APIError) -> LLMError:
    """Map SDK errors (most specific first) to reader-facing messages. Details stay in the server log."""
    response = getattr(e, "response", None)
    request_id = response.headers.get("request-id") if response is not None else None
    log.warning("Claude API error %s (request %s): %s", type(e).__name__, request_id, e)
    if isinstance(e, anthropic.AuthenticationError):
        return LLMError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in backend/.env.")
    if isinstance(e, anthropic.PermissionDeniedError):
        return LLMError("This Anthropic API key isn't allowed to use the configured model.")
    if isinstance(e, anthropic.NotFoundError):
        return LLMError("The configured Claude model wasn't found. Check LLM_MODEL in backend/.env.")
    if isinstance(e, anthropic.RateLimitError):
        return LLMError("The assistant is rate-limited right now. Try again in a minute.", retryable=True)
    if isinstance(e, anthropic.BadRequestError):
        # 400s cover several causes (no credit left, a request too long); the API's own explanation says which.
        return LLMError(f"The assistant service rejected the request: {_api_message(e)}")
    if isinstance(e, anthropic.APIStatusError):
        return LLMError("The assistant service is temporarily unavailable. Try again shortly.", retryable=e.status_code >= 500)
    if isinstance(e, anthropic.APIConnectionError):  # includes APITimeoutError
        return LLMError("Couldn't reach the assistant service. Check the internet connection.", retryable=True)
    return LLMError("The assistant failed unexpectedly.", retryable=True)
