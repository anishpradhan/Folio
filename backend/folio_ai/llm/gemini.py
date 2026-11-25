"""Gemini implementation of LLMProvider (google-genai SDK), for the free tier of the Gemini API.

Gemini has no API that returns citations into supplied documents, so citations are done in the prompt: each
source sentence is labelled `[source.sentence]` (e.g. `[2.3]`), the model is asked to put those labels right
after the sentences they support, and `CitationMarkers` turns them back into the same Citation/SpanEnd events
Claude's citation API produces. Labels are stripped from the answer text; labels that name no real sentence
are dropped by the chat layer. Quotes are taken from the stored sentences, so they are verbatim document text.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Iterator, Sequence

from ..config import Settings
from .base import Citation, Event, Finished, LLMError, SourceDoc, SpanEnd, T, TextDelta, Thinking, Turn

log = logging.getLogger("folio_ai.llm")

CITATION_RULES = """
How to cite: each sentence of the attached sources has a label like [2.3] (source 2, sentence 3). Put the
label of the sentence that supports a statement directly after that statement's closing punctuation, e.g.
"Each head attends to a lower-dimensional projection.[2.3]". For several sentences write [2.3][4.1]; for a run
of sentences in one source write [2.3-5]. Use only labels that appear in the sources, never invent one, and
don't add a list of references at the end."""

# Finish reasons that mean the model (or Google's filters) declined to answer.
DECLINED = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MODEL_ARMOR", "LANGUAGE"}


# Citation labels -----------------------------------------------------------------------------------

_REF = r"\d+\.\d+(?:\s*[-–]\s*\d+(?:\.\d+)?)?"
_MARKER = re.compile(rf"\[\s*({_REF}(?:\s*[,;]\s*{_REF})*)\s*\]")
_PARTIAL = re.compile(r"\[[\d.,;\s\-–]*$")  # what could still become a label once more text arrives
_HOLD_MAX = 60


def parse_refs(body: str) -> list[Citation]:
    """'2.3' -> blocks [2, 3) of source 1 (0-based); '2.3-5' and '2.3-2.5' -> [2, 5)."""
    out = []
    for ref in re.split(r"\s*[,;]\s*", body.strip()):
        m = re.fullmatch(r"(\d+)\.(\d+)(?:\s*[-–]\s*(?:(\d+)\.)?(\d+))?", ref)
        if not m:
            continue
        src, first = int(m.group(1)), int(m.group(2))
        if m.group(3) and int(m.group(3)) != src:  # a range across sources: cite its start only
            last = first
        else:
            last = int(m.group(4)) if m.group(4) else first
        out.append(Citation(src - 1, first - 1, max(last, first), ""))
    return out


class CitationMarkers:
    """Streams answer text with citation labels removed, emitting Citation + SpanEnd at each label.

    Text that might be the start of a label (an unclosed "[1.") is held back until it resolves, and whitespace
    just before a label is dropped so "claim [1.2]." reads "claim." with the chip after "claim"."""

    def __init__(self) -> None:
        self.buf = ""
        self.ws = ""  # trailing whitespace not yet emitted

    def _text(self, t: str) -> list[Event]:
        if not t:
            return []
        body = t.rstrip()
        trail = t[len(body) :]
        out: list[Event] = []
        if body:
            out.append(TextDelta(self.ws + body))
            self.ws = trail
        else:
            self.ws += trail
        return out

    def feed(self, text: str) -> list[Event]:
        self.buf += text
        out: list[Event] = []
        while True:
            m = _MARKER.search(self.buf)
            if not m:
                break
            out += self._text(self.buf[: m.start()])
            self.ws = ""  # whitespace before a label is dropped
            out += [*parse_refs(m.group(1)), SpanEnd()]
            self.buf = self.buf[m.end() :]
        p = _PARTIAL.search(self.buf)
        if p and len(self.buf) - p.start() <= _HOLD_MAX:
            out += self._text(self.buf[: p.start()])
            self.buf = self.buf[p.start() :]
        else:
            out += self._text(self.buf)
            self.buf = ""
        return out

    def flush(self) -> list[Event]:
        out = self._text(self.buf)  # an unfinished "[1." was just text
        self.buf = ""
        return [*out, SpanEnd()]


# Prompt formatting ---------------------------------------------------------------------------------


def _attr(v: str) -> str:
    return v.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def format_sources(sources: Sequence[SourceDoc], *, labelled: bool) -> str:
    parts = ["<sources>"]
    for i, d in enumerate(sources, start=1):
        ctx = f' context="{_attr(d.context)}"' if d.context else ""
        parts.append(f'<source id="{i}" title="{_attr(d.title)}"{ctx}>')
        for j, b in enumerate(d.blocks, start=1):
            text = " ".join(b.split()).replace("</source", "&lt;/source")
            parts.append(f"[{i}.{j}] {text}" if labelled else text)
        parts.append("</source>")
    parts.append("</sources>")
    return "\n".join(parts)


# Provider --------------------------------------------------------------------------------------------


def has_gemini_credentials(settings: Settings) -> bool:
    import os

    key = settings.gemini_api_key.get_secret_value() if settings.gemini_api_key else ""
    return bool(key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))


class GeminiProvider:
    def __init__(self, settings: Settings, client: Any = None):
        from google import genai

        key = settings.gemini_api_key.get_secret_value() if settings.gemini_api_key else None
        # Without a key in backend/.env the SDK reads GEMINI_API_KEY / GOOGLE_API_KEY itself.
        self._client = client or (genai.Client(api_key=key) if key else genai.Client())
        self.model = settings.gemini_model

    def _config(self, system: str, **extra: Any) -> Any:
        from google.genai import types

        return types.GenerateContentConfig(system_instruction=system, **extra)

    @staticmethod
    def _contents(history: Sequence[Turn], prompt: str) -> list[Any]:
        from google.genai import types

        turns = [types.Content(role="model" if t.role == "assistant" else "user", parts=[types.Part.from_text(text=t.text)]) for t in history]
        return [*turns, types.Content(role="user", parts=[types.Part.from_text(text=prompt)])]

    # Answers ----------------------------------------------------------------------------------------

    def stream_answer(
        self, *, system: str, history: Sequence[Turn], sources: Sequence[SourceDoc], prompt: str, effort: str
    ) -> Iterator[Event]:
        # `effort` is a Claude setting; Gemini models use their own default thinking.
        user = f"{format_sources(sources, labelled=True)}\n\n{prompt}"
        markers = CitationMarkers()
        finish: str | None = None
        usage: dict[str, Any] = {}
        model = self.model
        yield Thinking()
        try:
            stream = self._client.models.generate_content_stream(
                model=self.model, contents=self._contents(history, user), config=self._config(system + "\n" + CITATION_RULES)
            )
            for chunk in stream:
                fb = getattr(chunk, "prompt_feedback", None)
                if fb is not None and getattr(fb, "block_reason", None):
                    finish = "SAFETY"
                    break
                if chunk.candidates and chunk.candidates[0].finish_reason:
                    finish = chunk.candidates[0].finish_reason.name
                if chunk.usage_metadata:
                    usage = {
                        "input_tokens": chunk.usage_metadata.prompt_token_count,
                        "output_tokens": chunk.usage_metadata.candidates_token_count,
                    }
                model = chunk.model_version or model
                text = _chunk_text(chunk)
                if text:
                    yield from markers.feed(text)
        except Exception as e:  # noqa: BLE001 - mapped to a reader-facing message below
            raise _llm_error(e) from e
        yield from markers.flush()
        stop = "refusal" if finish in DECLINED else "max_tokens" if finish == "MAX_TOKENS" else "end_turn"
        yield Finished(stop, model, {k: v for k, v in usage.items() if v is not None})

    # Short completions ------------------------------------------------------------------------------

    def complete(self, *, system: str, prompt: str, effort: str, max_tokens: int = 2048) -> str:
        try:
            res = self._client.models.generate_content(model=self.model, contents=prompt, config=self._config(system))
        except Exception as e:  # noqa: BLE001
            raise _llm_error(e) from e
        text = _chunk_text(res)
        if not text:
            raise LLMError("The assistant returned no text for this request.")
        return text.strip()

    def complete_json(self, *, system: str, prompt: str, schema: type[T], effort: str, sources: Sequence[SourceDoc] = ()) -> T:
        content = f"{format_sources(sources, labelled=False)}\n\n{prompt}" if sources else prompt
        try:
            res = self._client.models.generate_content(
                model=self.model,
                contents=content,
                config=self._config(system, response_mime_type="application/json", response_schema=schema),
            )
        except Exception as e:  # noqa: BLE001
            raise _llm_error(e) from e
        parsed = getattr(res, "parsed", None)
        if isinstance(parsed, schema):
            return parsed
        try:
            return schema.model_validate_json(_chunk_text(res) or "")
        except ValueError as e:
            raise LLMError("The assistant couldn't produce a structured answer for this request.") from e


def _chunk_text(resp: Any) -> str:
    """The answer text of a response or stream chunk, skipping thought parts."""
    out = []
    for cand in (resp.candidates or [])[:1]:
        for part in (cand.content.parts if cand.content and cand.content.parts else []):
            if getattr(part, "thought", False):
                continue
            if part.text:
                out.append(part.text)
    return "".join(out)


def _llm_error(e: Exception) -> LLMError:
    """Map google-genai errors to reader-facing messages. Details stay in the server log."""
    from google.genai import errors

    if isinstance(e, LLMError):
        return e
    log.warning("Gemini API error %s: %s", type(e).__name__, e)
    if isinstance(e, errors.APIError):
        code = e.code or 0
        detail = (e.message or "").strip()[:300]
        if code == 429:
            return LLMError(
                "The Gemini free-tier limit was reached. Wait a minute, or until tomorrow if the daily limit is used up.",
                retryable=True,
            )
        if code in (401, 403) or "API key" in detail:
            return LLMError("The Gemini API key was rejected. Check GEMINI_API_KEY in backend/.env.")
        if code == 404:
            return LLMError("The configured Gemini model wasn't found. Check GEMINI_MODEL in backend/.env.")
        if code >= 500:
            return LLMError("The Gemini service is temporarily unavailable. Try again shortly.", retryable=True)
        return LLMError(f"The assistant service rejected the request: {detail or 'no details were given.'}")
    import httpx

    if isinstance(e, httpx.HTTPError):
        return LLMError("Couldn't reach the Gemini service. Check the internet connection.", retryable=True)
    return LLMError("The assistant failed unexpectedly.", retryable=True)
