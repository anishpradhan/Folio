"""Qdrant storage of chunk vectors: a dense vector and a BM25 sparse vector per chunk, plus provenance payload."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Sequence

from qdrant_client import QdrantClient, models

from .config import Settings
from .embeddings import SparseVector, model_slug

DENSE = "dense"
SPARSE = "bm25"
_NS = uuid.UUID("6f1c3c1e-6d2b-4c0e-9a77-1f6b0e0f5a11")


def point_id(chunk_id: str) -> str:
    return str(uuid.uuid5(_NS, chunk_id))


@dataclass
class ChunkPoint:
    chunk_id: str
    dense: list[float]
    sparse: SparseVector
    payload: dict[str, Any]


@dataclass
class Hit:
    chunk_id: str
    score: float
    payload: dict[str, Any]


class VectorStore:
    def __init__(self, settings: Settings, embedding_model: str, dims: int, client: QdrantClient | None = None):
        self.remote = client is None and bool(settings.qdrant_url)
        if client is not None:
            self.client = client
        elif settings.qdrant_url:
            key = settings.qdrant_api_key.get_secret_value() if settings.qdrant_api_key else None
            self.client = QdrantClient(url=settings.qdrant_url, api_key=key)
        else:
            self.client = QdrantClient(path=str(settings.qdrant_path))
        # One collection per embedding model: vectors from different models must never be compared.
        self.collection = f"folio_chunks__{model_slug(embedding_model)}"
        self.dims = dims
        self._ensure()

    def _ensure(self) -> None:
        if self.client.collection_exists(self.collection):
            return
        self.client.create_collection(
            self.collection,
            vectors_config={DENSE: models.VectorParams(size=self.dims, distance=models.Distance.COSINE)},
            sparse_vectors_config={SPARSE: models.SparseVectorParams(modifier=models.Modifier.IDF)},
        )
        if not self.remote:
            return  # embedded Qdrant scans payloads directly; indexes only help a server
        for field, schema in (
            ("document_id", models.PayloadSchemaType.KEYWORD),
            ("section_ids", models.PayloadSchemaType.KEYWORD),
            ("page_start", models.PayloadSchemaType.INTEGER),
        ):
            self.client.create_payload_index(self.collection, field, schema)

    def delete_document(self, document_id: str) -> None:
        self.client.delete(
            self.collection,
            points_selector=models.FilterSelector(filter=_doc_filter(document_id)),
            wait=True,
        )

    def upsert(self, points: Sequence[ChunkPoint], batch: int = 128) -> None:
        for i in range(0, len(points), batch):
            self.client.upsert(
                self.collection,
                points=[
                    models.PointStruct(
                        id=point_id(p.chunk_id),
                        vector={DENSE: p.dense, SPARSE: models.SparseVector(indices=p.sparse.indices, values=p.sparse.values)},
                        payload={**p.payload, "chunk_id": p.chunk_id},
                    )
                    for p in points[i : i + batch]
                ],
                wait=True,
            )

    def count(self, document_id: str) -> int:
        return self.client.count(self.collection, count_filter=_doc_filter(document_id), exact=True).count

    def hybrid_search(
        self,
        dense: list[float] | None,
        sparse: SparseVector | None,
        document_id: str,
        *,
        section_id: str | None = None,
        pages: tuple[int, int] | None = None,
        limit: int = 10,
        candidates: int = 40,
        mode: str = "hybrid",
    ) -> list[Hit]:
        """Dense + BM25 candidates fused with reciprocal rank fusion, filtered to the scope."""
        flt = _doc_filter(document_id, section_id, pages)
        if (mode != "bm25" and dense is None) or (mode != "dense" and sparse is None):
            raise ValueError(f"{mode} search needs the matching query vector(s)")
        sparse_q = models.SparseVector(indices=sparse.indices, values=sparse.values) if sparse else None
        if mode == "dense":
            res = self.client.query_points(self.collection, query=dense, using=DENSE, query_filter=flt, limit=limit, with_payload=True)
        elif mode == "bm25":
            res = self.client.query_points(self.collection, query=sparse_q, using=SPARSE, query_filter=flt, limit=limit, with_payload=True)
        else:
            res = self.client.query_points(
                self.collection,
                prefetch=[
                    models.Prefetch(query=dense, using=DENSE, filter=flt, limit=candidates),
                    models.Prefetch(query=sparse_q, using=SPARSE, filter=flt, limit=candidates),
                ],
                query=models.FusionQuery(fusion=models.Fusion.RRF),
                limit=limit,
                with_payload=True,
            )
        return [Hit(chunk_id=p.payload["chunk_id"], score=p.score, payload=p.payload) for p in res.points]

    def close(self) -> None:
        self.client.close()


def _doc_filter(document_id: str, section_id: str | None = None, pages: tuple[int, int] | None = None) -> models.Filter:
    must: list[models.Condition] = [models.FieldCondition(key="document_id", match=models.MatchValue(value=document_id))]
    if section_id:
        must.append(models.FieldCondition(key="section_ids", match=models.MatchAny(any=[section_id])))
    if pages:
        # Chunk overlaps [a, b]: page_start <= b and page_end >= a.
        must.append(models.FieldCondition(key="page_start", range=models.Range(lte=pages[1])))
        must.append(models.FieldCondition(key="page_end", range=models.Range(gte=pages[0])))
    return models.Filter(must=must)
