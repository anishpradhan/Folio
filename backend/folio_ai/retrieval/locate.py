"""Find the passage a reader selected in the PDF.

pdf.js selection text and Docling's text differ in whitespace, line-break hyphens and ligatures, so both
sides are normalised to lowercase letters and digits only before matching."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select

from ..db import Chunk, Database
from ..textutil import fold as _fold
from ..textutil import normalise
from .retriever import Passage

_WORD = re.compile(r"[0-9a-z]{3,}")
MIN_SPAN = 20  # normalised characters a passage must share with the selection's start or end
MIN_WORD_OVERLAP = 0.6


@dataclass
class Located:
    passage: Passage
    match: Literal["exact", "start", "end", "words"]


def locate_selection(db: Database, document_id: str, text: str, page: int | None = None) -> Located | None:
    """The chunk containing the selection: exact match, then where it starts or ends (selection spans two
    passages), then most words in common. Chunks on `page` are preferred; the whole document is the fallback."""
    needle = normalise(text)
    if len(needle) < 3:
        return None
    with db.session() as s:
        rows = [Passage.of(c) for c in s.scalars(select(Chunk).where(Chunk.document_id == document_id).order_by(Chunk.ordinal))]
    on_page = [p for p in rows if page is not None and p.page_start <= page <= p.page_end]
    for pool in ([on_page, rows] if on_page else [rows]):
        found = _match(pool, needle, text)
        if found:
            return found
    return None


def _longest(needle: str, hay: str, *, prefix: bool) -> int:
    """Length of the longest prefix (or suffix) of `needle` found in `hay` (binary search: monotonic)."""
    lo, hi = 0, len(needle)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if (needle[:mid] if prefix else needle[-mid:]) in hay:
            lo = mid
        else:
            hi = mid - 1
    return lo


def _match(pool: list[Passage], needle: str, raw: str) -> Located | None:
    hay = [(p, normalise(p.text)) for p in pool]
    for p, h in hay:
        if needle in h:
            return Located(p, "exact")
    # A selection across two passages: the passage holding the longer piece of its start or its end.
    best_span: tuple[int, Located] | None = None
    for p, h in hay:
        for kind, n in (("start", _longest(needle, h, prefix=True)), ("end", _longest(needle, h, prefix=False))):
            if n >= min(MIN_SPAN, len(needle)) and (best_span is None or n > best_span[0]):
                best_span = (n, Located(p, kind))  # type: ignore[arg-type]
    if best_span:
        return best_span[1]
    words = set(_WORD.findall(_fold(raw)))
    if not words:
        return None
    best, best_score = None, 0.0
    for p, _ in hay:
        score = len(words & set(_WORD.findall(_fold(p.text)))) / len(words)
        if score > best_score:
            best, best_score = p, score
    return Located(best, "words") if best is not None and best_score >= MIN_WORD_OVERLAP else None
