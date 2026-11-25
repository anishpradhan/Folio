"""Provider-neutral types for grounded generation.

Sources go to the model as documents split into numbered blocks (sentences). The model cites ranges of
blocks, and the chat layer resolves each range to a quote, a page and rectangles in the PDF."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator, Literal, Protocol, Sequence, TypeVar, Union

from pydantic import BaseModel


@dataclass
class SourceDoc:
    title: str
    blocks: list[str]
    context: str | None = None  # shown to the model next to the title, e.g. "pp. 4-5"


@dataclass
class Turn:
    role: Literal["user", "assistant"]
    text: str


# Streamed events ----------------------------------------------------------------------------------


@dataclass
class Thinking:
    """The model is reasoning before it answers (no text is exposed)."""


@dataclass
class TextDelta:
    text: str


@dataclass
class Citation:
    """The current span of text is supported by blocks [start_block, end_block) of source `doc_index` (0-based)."""

    doc_index: int
    start_block: int
    end_block: int
    quote: str


@dataclass
class SpanEnd:
    """The end of a span of answer text; citations received since the last SpanEnd belong to it."""


@dataclass
class Finished:
    stop_reason: str | None
    model: str
    usage: dict[str, Any] = field(default_factory=dict)


Event = Union[Thinking, TextDelta, Citation, SpanEnd, Finished]
T = TypeVar("T", bound=BaseModel)


class LLMError(Exception):
    """A generation failure with a message fit for the reader."""

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class LLMProvider(Protocol):
    model: str

    def stream_answer(
        self, *, system: str, history: Sequence[Turn], sources: Sequence[SourceDoc], prompt: str, effort: str
    ) -> Iterator[Event]:
        """Answer `prompt` from `sources`, streaming text and citations. Ends with exactly one Finished."""
        ...

    def complete(self, *, system: str, prompt: str, effort: str, max_tokens: int = 2048) -> str:
        """A short, non-streamed text completion (e.g. rewriting a follow-up question)."""
        ...

    def complete_json(self, *, system: str, prompt: str, schema: type[T], effort: str, sources: Sequence[SourceDoc] = ()) -> T:
        """A structured completion validated against `schema`."""
        ...
