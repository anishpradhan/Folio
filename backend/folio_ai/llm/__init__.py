"""LLM generation (responsibility 6): a provider-neutral interface and the Claude implementation."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import Citation, Event, Finished, LLMError, LLMProvider, SourceDoc, SpanEnd, TextDelta, Thinking, Turn

if TYPE_CHECKING:
    from ..config import Settings

__all__ = ["Citation", "Event", "Finished", "LLMError", "LLMProvider", "SourceDoc", "SpanEnd", "TextDelta", "Thinking", "Turn", "make_llm"]


def make_llm(settings: Settings) -> LLMProvider:
    if settings.llm_fake:
        from .fake import ScriptedLLM

        return ScriptedLLM()
    if settings.llm_provider == "gemini":
        from .gemini import GeminiProvider

        return GeminiProvider(settings)
    from .claude import ClaudeProvider

    return ClaudeProvider(settings)
