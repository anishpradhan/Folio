"""Scoped hybrid retrieval: dense + BM25 fused with RRF in Qdrant, then (optionally) a cross-encoder rerank."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal

from sqlalchemy import select

from ..config import Settings
from ..db import Chunk, Database
from ..services import Services

log = logging.getLogger("folio_ai.retrieval")

Mode = Literal["hybrid", "dense", "bm25"]


@dataclass(frozen=True)
class Scope:
    """Where to search: the whole document, a section (including its subsections), and/or a page range."""

    section_id: str | None = None
    page_start: int | None = None
    page_end: int | None = None

    @property
    def pages(self) -> tuple[int, int] | None:
        if self.page_start is None and self.page_end is None:
            return None
        return (self.page_start or 1, self.page_end or 10**6)


@dataclass
class Passage:
    """A chunk as plain data (no database session needed), with everything a citation needs."""

    id: str
    ordinal: int
    section_id: str | None
    heading_path: list[str]
    text: str
    embed_text: str
    page_start: int
    page_end: int
    locations: list[Any]
    token_count: int
    kinds: list[str] = field(default_factory=list)
    blocks: list[dict[str, Any]] = field(default_factory=list)  # citation units: {text, locations}

    @classmethod
    def of(cls, c: Chunk) -> Passage:
        return cls(
            id=c.id,
            ordinal=c.ordinal,
            section_id=c.section_id,
            heading_path=list(c.heading_path or []),
            text=c.text,
            embed_text=c.embed_text,
            page_start=c.page_start,
            page_end=c.page_end,
            locations=list(c.locations or []),
            token_count=c.token_count,
            kinds=list(c.kinds or []),
            blocks=list(c.blocks or []),
        )

    def json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "ordinal": self.ordinal,
            "sectionId": self.section_id,
            "headingPath": self.heading_path,
            "text": self.text,
            "pageStart": self.page_start,
            "pageEnd": self.page_end,
            "locations": self.locations,
            "tokenCount": self.token_count,
            "kinds": self.kinds,
        }


@dataclass
class RetrievedChunk:
    passage: Passage
    rank: int  # 1-based, after reranking
    score: float  # the score the ranking used: rerank score when reranked, else the fused/single score
    fused_score: float
    rerank_score: float | None = None

    def json(self) -> dict[str, Any]:
        return {"rank": self.rank, "score": self.score, "fusedScore": self.fused_score, "rerankScore": self.rerank_score, **self.passage.json()}


@dataclass
class Retrieval:
    hits: list[RetrievedChunk]
    reranked: bool
    reranker: str | None


def load_passages(db: Database, ids: Iterable[str]) -> dict[str, Passage]:
    ids = list(ids)
    if not ids:
        return {}
    with db.session() as s:
        return {c.id: Passage.of(c) for c in s.scalars(select(Chunk).where(Chunk.id.in_(ids)))}


class Retriever:
    def __init__(self, db: Database, services: Services, settings: Settings):
        self.db = db
        self.services = services
        self.settings = settings

    def search(
        self,
        document_id: str,
        query: str,
        *,
        scope: Scope = Scope(),
        limit: int = 8,
        mode: Mode = "hybrid",
        rerank: bool | None = None,
        exclude: Iterable[str] = (),
    ) -> Retrieval:
        sv, st = self.services, self.settings
        excluded = set(exclude)
        want_rerank = st.rerank_by_default if rerank is None else rerank
        reranker = sv.get_reranker() if want_rerank else None
        n = (max(st.rerank_candidates, limit) if reranker else limit) + len(excluded)

        with sv.lock:
            dense = sv.embedder.embed_query(query) if mode != "bm25" else None
            sparse = sv.bm25.embed_query(query) if mode != "dense" else None
            raw = sv.store.hybrid_search(
                dense, sparse, document_id, section_id=scope.section_id, pages=scope.pages, limit=n, mode=mode
            )
        raw = [h for h in raw if h.chunk_id not in excluded]
        passages = load_passages(self.db, (h.chunk_id for h in raw))
        cands = [(passages[h.chunk_id], h.score) for h in raw if h.chunk_id in passages]

        if reranker and cands:
            with sv.lock:
                scores = reranker.score(query, [p.embed_text for p, _ in cands])
            order = sorted(range(len(cands)), key=lambda i: scores[i], reverse=True)
            hits = [
                RetrievedChunk(cands[i][0], rank, scores[i], cands[i][1], scores[i])
                for rank, i in enumerate(order[:limit], start=1)
            ]
        else:
            hits = [RetrievedChunk(p, rank, s, s) for rank, (p, s) in enumerate(cands[:limit], start=1)]
        return Retrieval(hits, reranked=bool(reranker and cands), reranker=reranker.model if reranker else None)
