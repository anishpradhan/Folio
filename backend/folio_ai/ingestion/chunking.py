"""Structure-aware hierarchical chunking of a parsed DoclingDocument.

* Section tree: Docling reports every PDF heading at level 1, so the hierarchy is rebuilt from heading
  numbering ("3.2.1" → level 3; "A.1" → level 2), with well-known unnumbered headings (Abstract,
  References…) at the top level and other unnumbered headings nested under the current section.
* Chunks: Docling's HybridChunker — splits along the document tree, merges small siblings, splits
  oversized items using the embedding model's own tokenizer — so a chunk never straddles two sections.
* Provenance: every chunk keeps its pages and the bounding boxes of its source items, normalised to the
  page (0..1, top-left origin): the same space as the reader's highlight rectangles.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.base import BaseTokenizer
from docling_core.types.doc import DocItemLabel, DoclingDocument
from pydantic import ConfigDict

from ..textutil import normalise, split_sentences


# ---------------------------------------------------------------------------------- tokenizers
class HFTokenizer(BaseTokenizer):
    """A `tokenizers` tokenizer (no transformers import needed), counting without truncation."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    tokenizer: Any
    max_tokens: int

    def count_tokens(self, text: str) -> int:
        return len(self.tokenizer.encode(text, add_special_tokens=False).ids)

    def get_max_tokens(self) -> int:
        return self.max_tokens

    def get_tokenizer(self) -> Any:
        return self.tokenizer


class TiktokenTokenizer(BaseTokenizer):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    tokenizer: Any
    max_tokens: int

    def count_tokens(self, text: str) -> int:
        return len(self.tokenizer.encode(text, disallowed_special=()))

    def get_max_tokens(self) -> int:
        return self.max_tokens

    def get_tokenizer(self) -> Any:
        return self.tokenizer


class WordTokenizer(BaseTokenizer):
    """Approximation for models without a known tokenizer (≈1.3 tokens per word)."""

    max_tokens: int

    def count_tokens(self, text: str) -> int:
        return int(len(text.split()) * 1.3) + 1

    def get_max_tokens(self) -> int:
        return self.max_tokens

    def get_tokenizer(self) -> Any:
        return None


@lru_cache(maxsize=4)
def make_tokenizer(model: str, max_tokens: int, models_dir: str | None = None) -> BaseTokenizer:
    if model.startswith("text-embedding-"):
        import tiktoken

        return TiktokenTokenizer(tokenizer=tiktoken.get_encoding("cl100k_base"), max_tokens=max_tokens)
    if "/" in model:
        from tokenizers import Tokenizer

        tok = None
        if models_dir:  # fastembed already downloaded the model, tokenizer.json included
            slug = model.split("/")[-1].lower()
            for p in Path(models_dir).glob("**/tokenizer.json"):
                if slug in str(p).lower():
                    tok = Tokenizer.from_file(str(p))
                    break
        tok = tok or Tokenizer.from_pretrained(model)
        tok.no_truncation()
        return HFTokenizer(tokenizer=tok, max_tokens=max_tokens)
    return WordTokenizer(max_tokens=max_tokens)


# ---------------------------------------------------------------------------------- sections
CONTEXT_RESERVE = 48

TOP_LEVEL = re.compile(
    r"^(abstract|introduction|background|related work|conclusions?|discussion|references|bibliography|"
    r"acknowledge?ments?|appendix|appendices|supplementary( material)?|limitations|"
    r"broader impact|ethics statement|summary)\b",
    re.I,
)
NUMBERED = re.compile(r"^\s*((?:\d+|[A-Z])(?:\.\d+)*)\.?\s+\S")
ROMAN = re.compile(r"^\s*([IVXLC]+)\.\s+\S")


def heading_level(text: str, current: int) -> tuple[int, bool]:
    """(level, numbered) for a heading, given the level of the section we're in."""
    m = NUMBERED.match(text)
    if m:
        token = m.group(1)
        # A lone capital letter only counts as numbering when followed by a dot ("A. Proofs", "A.1 …").
        if not (len(token) == 1 and token.isalpha() and not re.match(r"^\s*[A-Z]\.", text)):
            return token.count(".") + 1, True
    if ROMAN.match(text):
        return 1, True
    if TOP_LEVEL.match(text.strip()):
        return 1, False
    return current + 1 if current else 1, False


@dataclass
class SectionRec:
    id: str
    parent_id: str | None
    ordinal: int
    level: int
    title: str
    page_start: int | None = None
    page_end: int | None = None
    ancestors: list[str] = field(default_factory=list)  # ids, root first, including self
    path: list[str] = field(default_factory=list)  # titles, root first, including self


@dataclass
class ChunkRec:
    id: str
    ordinal: int
    section_id: str | None
    section_ids: list[str]
    heading_path: list[str]
    text: str
    embed_text: str
    page_start: int
    page_end: int
    locations: list[dict[str, Any]]
    token_count: int
    kinds: list[str]
    blocks: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ChunkedDocument:
    title: str | None
    page_count: int
    sections: list[SectionRec]
    chunks: list[ChunkRec]


def _build_sections(document_id: str, doc: DoclingDocument) -> tuple[list[SectionRec], dict[str, SectionRec], str | None]:
    """Walk the body in reading order; map every item (self_ref) to the section containing it."""
    sections: list[SectionRec] = []
    item_section: dict[str, SectionRec] = {}
    stack: list[SectionRec] = []
    title: str | None = None
    seen_numbered = False

    for item, _depth in doc.iterate_items():
        label = item.label
        pages = [p.page_no for p in getattr(item, "prov", [])]
        if label == DocItemLabel.TITLE and title is None:
            title = item.text.strip()
        if label in (DocItemLabel.SECTION_HEADER, DocItemLabel.TITLE):
            text = re.sub(r"\s+", " ", item.text).strip()
            if not text:
                continue
            # A paper's title is usually reported as the first heading on page 1.
            if title is None and not sections and pages[:1] == [1] and not NUMBERED.match(text) and not TOP_LEVEL.match(text):
                title = text
            level, numbered = heading_level(text, stack[-1].level if stack else 0)
            seen_numbered |= numbered
            # In a numbered paper, an unnumbered non-standard heading (figure labels, run-in titles)
            # nests under the current section rather than ending it.
            if not numbered and seen_numbered and not TOP_LEVEL.match(text) and stack:
                level = stack[-1].level + 1
            while stack and stack[-1].level >= level:
                stack.pop()
            parent = stack[-1] if stack else None
            sec = SectionRec(
                id=f"{document_id}:s{len(sections)}",
                parent_id=parent.id if parent else None,
                ordinal=len(sections),
                level=level,
                title=text,
                ancestors=[*(parent.ancestors if parent else []), ""],
                path=[*(parent.path if parent else []), text],
            )
            sec.ancestors[-1] = sec.id
            sections.append(sec)
            stack.append(sec)
        current = stack[-1] if stack else None
        if current is not None:
            item_section[item.self_ref] = current
            for anc_id in current.ancestors:  # pages roll up to every enclosing section
                anc = sections[int(anc_id.rsplit(":s", 1)[1])]
                for pg in pages:
                    anc.page_start = pg if anc.page_start is None else min(anc.page_start, pg)
                    anc.page_end = pg if anc.page_end is None else max(anc.page_end, pg)
    return sections, item_section, title


def _norm_rect(doc: DoclingDocument, prov: Any) -> dict[str, Any] | None:
    page = doc.pages.get(prov.page_no)
    if page is None or not page.size.width or not page.size.height:
        return None
    w, h = page.size.width, page.size.height
    bb = prov.bbox.to_top_left_origin(page_height=h)
    clamp = lambda v: max(0.0, min(1.0, v))  # noqa: E731
    x0, y0, x1, y1 = clamp(bb.l / w), clamp(bb.t / h), clamp(bb.r / w), clamp(bb.b / h)
    if x1 <= x0 or y1 <= y0:
        return None
    return {"page": prov.page_no, "rect": {"x": round(x0, 5), "y": round(y0, 5), "w": round(x1 - x0, 5), "h": round(y1 - y0, 5)}}


def citation_blocks(body: str, item_texts: list[str], item_locations: list[list[dict[str, Any]]], fallback: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Split a chunk into sentence-sized blocks, each with the page rectangles of the Docling item it came from.

    The model cites ranges of these blocks, so a citation resolves to an exact quote and its paragraph box.
    The chunk text is the chunker's serialisation (items joined by newlines, tables flattened), so each line
    is matched to the next item whose text it overlaps; unmatched lines keep the current item's boxes."""
    norm_items = [normalise(t) for t in item_texts]
    blocks: list[dict[str, Any]] = []
    j = 0
    current = item_locations[0] if item_locations and item_locations[0] else fallback
    for line in body.splitlines():
        n = normalise(line)
        if not n:
            continue
        probe = n[:40]
        for k in range(j, len(norm_items)):
            t = norm_items[k]
            if t and (probe in t or t[:40] in n):
                j = k
                current = item_locations[k] or current
                break
        for sentence in split_sentences(line):
            blocks.append({"text": sentence, "locations": current})
    return blocks


def chunk_document(document_id: str, parsed_json: Path | str, embedding_model: str, max_tokens: int = 512, models_dir: str | None = None) -> ChunkedDocument:
    doc = DoclingDocument.load_from_json(Path(parsed_json))
    sections, item_section, title = _build_sections(document_id, doc)
    # Chunk metadata holds bare item references; their text lives in the document.
    ref_text = {it.self_ref: getattr(it, "text", "") or "" for it, _ in doc.iterate_items()}
    # The chunker budgets for one heading; the title and full heading path added for embedding need room too.
    tokenizer = make_tokenizer(embedding_model, max(64, max_tokens - CONTEXT_RESERVE), models_dir)
    chunker = HybridChunker(tokenizer=tokenizer, merge_peers=True)

    chunks: list[ChunkRec] = []
    last_page = 1
    for raw in chunker.chunk(dl_doc=doc):
        body = raw.text.strip()
        if not body:
            continue
        items = raw.meta.doc_items
        item_locations = [[loc for p in getattr(it, "prov", []) if (loc := _norm_rect(doc, p))] for it in items]
        locations = [loc for locs in item_locations for loc in locs]
        # Items without provenance (rare in PDFs; normal for HTML) inherit the previous chunk's page.
        pages = [loc["page"] for loc in locations] or [p.page_no for it in items for p in getattr(it, "prov", [])] or [last_page]
        last_page = max(pages)
        sec = next((item_section[it.self_ref] for it in items if it.self_ref in item_section), None)
        path = sec.path if sec else []
        captions = [c for c in (raw.meta.captions or []) if c and c not in body]
        context = [t for t in ([title] if title and (not path or path[0] != title) else []) + path]
        embed_text = "\n".join([*context, *captions, body])
        ordinal = len(chunks)
        chunks.append(
            ChunkRec(
                id=f"{document_id}:c{ordinal}",
                ordinal=ordinal,
                section_id=sec.id if sec else None,
                section_ids=list(sec.ancestors) if sec else [],
                heading_path=list(path),
                text=body,
                embed_text=embed_text,
                page_start=min(pages),
                page_end=max(pages),
                locations=locations,
                token_count=tokenizer.count_tokens(embed_text),
                kinds=sorted({it.label.value for it in items}),
                blocks=citation_blocks(body, [ref_text.get(it.self_ref, "") for it in items], item_locations, locations[:1]),
            )
        )
    return ChunkedDocument(title=title, page_count=len(doc.pages), sections=sections, chunks=chunks)
