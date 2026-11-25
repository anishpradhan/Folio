"""A scripted LLMProvider for end-to-end tests and demos without an API key (LLM_FAKE=true; never the default).

Answers quote the first sentence of the first two sources and cite them, streamed in small pieces with short
pauses so the UI's streaming, stop and citation paths run for real. Questions containing "slowly" stream for
several seconds (to test stopping); questions containing "decline" end in a refusal."""

from __future__ import annotations

import time
from typing import Iterator, Sequence

from .base import Citation, Event, Finished, SourceDoc, SpanEnd, T, TextDelta, Thinking, Turn

PAUSE_S = 0.03


def _pieces(text: str, size: int = 12) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)]


class ScriptedLLM:
    model = "scripted-test-model"

    def stream_answer(
        self, *, system: str, history: Sequence[Turn], sources: Sequence[SourceDoc], prompt: str, effort: str
    ) -> Iterator[Event]:
        yield Thinking()
        time.sleep(PAUSE_S * 3)
        if "decline" in prompt.lower():
            yield Finished("refusal", self.model)
            return
        spans: list[tuple[str, Citation | None]] = []
        for i, doc in enumerate(sources[:2]):
            if doc.blocks:
                lead = "The document says" if i == 0 else " It also notes"
                quote = doc.blocks[0]
                spans.append((f"{lead}: “{quote.rstrip('.')}.”", Citation(i, 0, 1, quote)))
        if not spans:
            spans.append(("The document doesn't say.", None))
        if "slowly" in prompt.lower():
            spans += [(f" Still thinking aloud, part {k}.", None) for k in range(1, 60)]
        if history:
            spans.append((f" (Follow-up {len(history) // 2 + 1} in this conversation.)", None))
        for text, cite in spans:
            for piece in _pieces(text):
                time.sleep(PAUSE_S)
                yield TextDelta(piece)
            if cite:
                yield cite
            yield SpanEnd()
        yield Finished("end_turn", self.model, {"input_tokens": 0, "output_tokens": 0})

    def complete(self, *, system: str, prompt: str, effort: str, max_tokens: int = 2048) -> str:
        return prompt.rsplit("Follow-up question: ", 1)[-1].strip()

    def complete_json(self, *, system: str, prompt: str, schema: type[T], effort: str, sources: Sequence[SourceDoc] = ()) -> T:
        return schema(
            questions=[
                "What is the main argument of this document?",
                "How is the document organised?",
                "What does the author say about attention?",
                "Which examples does the author use?",
            ]
        )
