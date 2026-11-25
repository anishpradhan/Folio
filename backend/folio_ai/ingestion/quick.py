"""The quick pass: passages from the PDF's own text layer, searchable in seconds.

Docling's layout reading takes 2–4 s a page on a laptop CPU, so a long book would keep the Ask tab closed
for many minutes. This pass reads the text layer with pdfium (a fraction of a second for a paper), groups
its line pieces into paragraphs with their page rectangles, and cuts those into passages with the same
tokenizer and citation blocks as the full pass. It knows no headings, sections or tables; the full pass
replaces it when Docling finishes (docs/ai/architecture.md §18).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..textutil import split_sentences
from .chunking import CONTEXT_RESERVE, ChunkedDocument, ChunkRec, citation_blocks, make_tokenizer

SOFT_HYPHEN = "\x02"  # pdfium's mark for a hyphen inserted at a line break
_SPACES = re.compile(r"[ \t\r\n]+")
_SPACED_DECIMAL = re.compile(r"(\d) \. (\d)")
_PAGE_NUMBER = re.compile(r"^(page\s*)?\d{1,4}$", re.I)


@dataclass
class Paragraph:
    page: int
    text: str
    # PDF user space, bottom-left origin: left, bottom, right, top
    box: list[float]
    line_height: float
    last_line: list[float] = field(default_factory=list)


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _join(text: str, piece: str, *, tight: bool = False) -> str:
    """Join two pieces of text. A hyphen at a line end before a lowercase letter (or pdfium's line-break
    hyphen mark) is a broken word; pieces that touch on the same line (a subscript, a font change mid-word:
    "d" + "k", "0" + "." + "1") join without a space."""
    if not text:
        return piece
    if not piece:
        return text
    if text.endswith(SOFT_HYPHEN):
        return text[:-1] + piece
    if tight:
        return text + piece
    if text.endswith("-") and piece[:1].islower():
        return text[:-1] + piece
    return text + piece if text.endswith(" ") else f"{text} {piece}"


def _clean(text: str) -> str:
    """Leftover hyphen marks, and decimals that a math font spaced out ("0 . 1" → "0.1")."""
    return _SPACED_DECIMAL.sub(r"\1.\2", text.replace(SOFT_HYPHEN, ""))


def read_paragraphs(pdf_path: Path | str) -> tuple[list[Paragraph], int, str | None, dict[int, tuple[float, float, float, float]]]:
    """Paragraphs in content order, the page count, the metadata title and each page's box."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        title = (pdf.get_metadata_dict().get("Title") or "").strip() or None
        paras: list[Paragraph] = []
        boxes: dict[int, tuple[float, float, float, float]] = {}
        for index in range(len(pdf)):
            page = pdf[index]
            page_no = index + 1
            try:
                boxes[page_no] = tuple(page.get_bbox())  # type: ignore[assignment]
                tp = page.get_textpage()
                try:
                    cur: Paragraph | None = None
                    last_right = 0.0  # right edge of the previous piece
                    for i in range(tp.count_rects()):
                        l, b, r, t = tp.get_rect(i)
                        piece = _SPACES.sub(" ", tp.get_text_bounded(l, b, r, t)).strip(" ")
                        if not piece or t - b <= 0:
                            continue
                        h = t - b
                        if cur is not None:
                            ll, lb, lr, lt = cur.last_line
                            if _overlap(lb, lt, b, t) >= 0.5 * min(h, lt - lb):  # same line
                                # pdfium starts a new piece at every font change; only a real gap is a space
                                tight = l - last_right < 0.12 * min(h, lt - lb)
                                cur.text = _join(cur.text, piece, tight=tight)
                                cur.last_line = [min(ll, l), min(lb, b), max(lr, r), max(lt, t)]
                                cur.box = [min(cur.box[0], l), min(cur.box[1], b), max(cur.box[2], r), max(cur.box[3], t)]
                                last_right = r
                                continue
                            gap = lb - t  # the next line starts below the previous one
                            if 0 <= gap <= 0.7 * max(h, cur.line_height) and _overlap(cur.box[0], cur.box[2], l, r) > 0:
                                cur.text = _join(cur.text, piece)
                                cur.last_line = [l, b, r, t]
                                cur.box = [min(cur.box[0], l), min(cur.box[1], b), max(cur.box[2], r), max(cur.box[3], t)]
                                last_right = r
                                continue
                            paras.append(cur)
                        cur = Paragraph(page=page_no, text=piece, box=[l, b, r, t], line_height=h, last_line=[l, b, r, t])
                        last_right = r
                    if cur is not None:
                        paras.append(cur)
                finally:
                    tp.close()
            finally:
                page.close()
        for p in paras:
            p.text = _clean(p.text)
        return paras, len(pdf), title, boxes
    finally:
        pdf.close()


def _location(p: Paragraph, box: tuple[float, float, float, float]) -> dict[str, Any] | None:
    """The paragraph's box normalised to the page (0..1, top-left origin): the reader's highlight space."""
    left, bottom, right, top = box
    w, h = right - left, top - bottom
    if w <= 0 or h <= 0:
        return None
    clamp = lambda v: max(0.0, min(1.0, v))  # noqa: E731
    x0, x1 = clamp((p.box[0] - left) / w), clamp((p.box[2] - left) / w)
    y0, y1 = clamp((top - p.box[3]) / h), clamp((top - p.box[1]) / h)
    if x1 <= x0 or y1 <= y0:
        return None
    return {"page": p.page, "rect": {"x": round(x0, 5), "y": round(y0, 5), "w": round(x1 - x0, 5), "h": round(y1 - y0, 5)}}


def quick_chunks(
    document_id: str, pdf_path: Path | str, embedding_model: str, max_tokens: int = 512, models_dir: str | None = None, title: str | None = None
) -> ChunkedDocument:
    paras, page_count, meta_title, boxes = read_paragraphs(pdf_path)
    title = (title or "").strip() or meta_title
    tokenizer = make_tokenizer(embedding_model, max(64, max_tokens - CONTEXT_RESERVE), models_dir)
    budget = tokenizer.get_max_tokens()

    # Paragraphs that don't fit a passage on their own are cut at sentence ends (or, failing that, words).
    items: list[tuple[str, dict[str, Any] | None, int]] = []
    for p in paras:
        text = p.text.strip()
        if not text or _PAGE_NUMBER.match(text):
            continue
        loc = _location(p, boxes[p.page])
        n = tokenizer.count_tokens(text)
        if n <= budget:
            items.append((text, loc, n))
            continue
        buf = ""
        for sentence in split_sentences(text) or [text]:
            words = sentence.split()
            while words and tokenizer.count_tokens(" ".join(words)) > budget:  # a run-on "sentence"
                cut = max(1, len(words) // 2)
                while cut > 1 and tokenizer.count_tokens(" ".join(words[:cut])) > budget:
                    cut //= 2
                if buf:
                    items.append((buf, loc, tokenizer.count_tokens(buf)))
                    buf = ""
                part = " ".join(words[:cut])
                items.append((part, loc, tokenizer.count_tokens(part)))
                words = words[cut:]
            sentence = " ".join(words)
            if not sentence:
                continue
            joined = f"{buf} {sentence}".strip()
            if buf and tokenizer.count_tokens(joined) > budget:
                items.append((buf, loc, tokenizer.count_tokens(buf)))
                joined = sentence
            buf = joined
        if buf:
            items.append((buf, loc, tokenizer.count_tokens(buf)))

    chunks: list[ChunkRec] = []
    group: list[tuple[str, dict[str, Any] | None, int]] = []
    used = 0

    def flush() -> None:
        nonlocal group, used
        if not group:
            return
        texts = [t for t, _, _ in group]
        item_locations = [[loc] if loc else [] for _, loc, _ in group]
        locations = [loc for locs in item_locations for loc in locs]
        pages = [loc["page"] for loc in locations] or [chunks[-1].page_end if chunks else 1]
        body = "\n".join(texts)
        embed_text = f"{title}\n{body}" if title else body
        ordinal = len(chunks)
        chunks.append(
            ChunkRec(
                id=f"{document_id}:q{ordinal}",
                ordinal=ordinal,
                section_id=None,
                section_ids=[],
                heading_path=[],
                text=body,
                embed_text=embed_text,
                page_start=min(pages),
                page_end=max(pages),
                locations=locations,
                token_count=tokenizer.count_tokens(embed_text),
                kinds=["text"],
                blocks=citation_blocks(body, texts, item_locations, locations[:1]),
            )
        )
        group, used = [], 0

    for item in items:
        if group and used + item[2] + 1 > budget:  # +1 for the newline between items
            flush()
        group.append(item)
        used += item[2] + 1
    flush()
    return ChunkedDocument(title=title, page_count=page_count, sections=[], chunks=chunks)
