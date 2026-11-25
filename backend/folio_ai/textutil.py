"""Text normalisation shared by ingestion (block alignment) and retrieval (selection lookup)."""

from __future__ import annotations

import re
import unicodedata

_NON_ALNUM = re.compile(r"[^0-9a-z]+")
# A sentence ends at . ! ? (optionally followed by a closing quote/bracket) and whitespace.
_SENTENCE_END = re.compile(r"(?<=[.!?])[\"'”’)\]]*\s+")
# Abbreviations that end with a period but don't end a sentence.
_ABBREV = re.compile(r"(?:\b(?:e\.g|i\.e|et al|cf|vs|approx|resp|fig|figs|eq|eqs|sec|tab|no|ref|refs)|\b[A-Z])\.$", re.I)
MIN_SENTENCE = 40  # shorter pieces are merged with their neighbour (headings, "Fig. 2.", list stubs)


def fold(s: str) -> str:
    return unicodedata.normalize("NFKC", s).lower()


def normalise(s: str) -> str:
    """Lowercase letters and digits only: immune to whitespace, line-break hyphens and ligatures."""
    return _NON_ALNUM.sub("", fold(s))


def split_sentences(paragraph: str) -> list[str]:
    """Sentence-sized pieces for citation blocks. Conservative: a wrong merge only makes a citation longer."""
    text = paragraph.strip()
    if not text:
        return []
    if text.startswith("|") or text.count(" | ") >= 3:  # serialised table: keep whole
        return [text]
    out: list[str] = []
    buf = ""
    pos = 0
    for m in _SENTENCE_END.finditer(text):
        piece = text[pos : m.end()].strip()
        pos = m.end()
        buf = f"{buf} {piece}" if buf else piece
        if _ABBREV.search(buf.rstrip("\"'”’)]")) or len(buf) < MIN_SENTENCE:
            continue
        out.append(buf)
        buf = ""
    rest = text[pos:].strip()
    buf = f"{buf} {rest}".strip() if rest else buf
    if buf:
        if out and len(buf) < MIN_SENTENCE:
            out[-1] = f"{out[-1]} {buf}"
        else:
            out.append(buf)
    return out
