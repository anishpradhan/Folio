"""Context assembly: pick passages within a token budget, restore reading order, merge neighbours, number them.

The numbers ([1], [2], …) are what the model cites in phase 3; each source keeps its chunk ids, pages and
rectangles so a citation resolves back to the exact place in the PDF."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from ..textutil import split_sentences
from .retriever import Passage


def passage_blocks(p: Passage) -> list[dict[str, Any]]:
    """The passage's citation blocks, tagged with its chunk id. Documents ingested before citation blocks
    existed fall back to sentences of the text with the passage's first location."""
    if p.blocks:
        return [{**b, "chunkId": p.id} for b in p.blocks]
    return [{"text": s, "locations": p.locations[:1], "chunkId": p.id} for line in p.text.splitlines() for s in split_sentences(line)]


@dataclass
class Source:
    n: int
    chunk_ids: list[str]
    section_id: str | None
    heading_path: list[str]
    page_start: int
    page_end: int
    text: str
    locations: list[Any]
    token_count: int
    best_rank: int  # best retrieval rank among the merged passages (1 = most relevant)
    blocks: list[dict[str, Any]] = field(default_factory=list)  # what the model cites: {text, locations, chunkId}

    @property
    def pages_label(self) -> str:
        return f"p. {self.page_start}" if self.page_start == self.page_end else f"pp. {self.page_start}–{self.page_end}"

    def render(self) -> str:
        where = " › ".join(self.heading_path) or "(untitled)"
        return f"[{self.n}] {where} ({self.pages_label})\n{self.text.strip()}"

    def json(self) -> dict[str, Any]:
        return {
            "n": self.n,
            "chunkIds": self.chunk_ids,
            "sectionId": self.section_id,
            "headingPath": self.heading_path,
            "pageStart": self.page_start,
            "pageEnd": self.page_end,
            "text": self.text,
            "locations": self.locations,
            "tokenCount": self.token_count,
            "bestRank": self.best_rank,
        }


@dataclass
class Context:
    sources: list[Source]
    token_count: int
    omitted: list[str] = field(default_factory=list)  # chunk ids left out to stay within the budget

    def render(self) -> str:
        return "\n\n".join(s.render() for s in self.sources)

    def source(self, n: int) -> Source | None:
        return self.sources[n - 1] if 1 <= n <= len(self.sources) else None


def assemble_context(passages: Sequence[Passage], budget_tokens: int) -> Context:
    """`passages` in priority order (most relevant first). The first one is always kept, even over budget."""
    kept: list[tuple[int, Passage]] = []
    omitted: list[str] = []
    seen: set[str] = set()
    used = 0
    for rank, p in enumerate(passages, start=1):
        if p.id in seen:
            continue
        seen.add(p.id)
        if kept and used + p.token_count > budget_tokens:
            omitted.append(p.id)  # a smaller, later passage may still fit
            continue
        kept.append((rank, p))
        used += p.token_count

    kept.sort(key=lambda rp: rp[1].ordinal)
    groups: list[list[tuple[int, Passage]]] = []
    for rp in kept:
        prev = groups[-1][-1][1] if groups else None
        if prev is not None and rp[1].ordinal == prev.ordinal + 1 and rp[1].section_id == prev.section_id:
            groups[-1].append(rp)
        else:
            groups.append([rp])

    sources = [
        Source(
            n=i,
            chunk_ids=[p.id for _, p in g],
            section_id=g[0][1].section_id,
            heading_path=g[0][1].heading_path,
            page_start=min(p.page_start for _, p in g),
            page_end=max(p.page_end for _, p in g),
            text="\n\n".join(p.text.strip() for _, p in g),
            locations=[loc for _, p in g for loc in p.locations],
            token_count=sum(p.token_count for _, p in g),
            best_rank=min(r for r, _ in g),
            blocks=[b for _, p in g for b in passage_blocks(p)],
        )
        for i, g in enumerate(groups, start=1)
    ]
    return Context(sources, used, omitted)
