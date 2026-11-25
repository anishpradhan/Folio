"""Embedding providers: dense (OpenAI or local ONNX) and sparse BM25 for hybrid search."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Protocol, Sequence

from .config import Settings


QUOTA_CODES = ("insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached")


class TransientError(Exception):
    """A failure worth retrying automatically (network, rate limit, provider 5xx)."""


class EmbeddingProvider(Protocol):
    model: str
    dims: int

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...


def model_slug(model: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", model.lower()).strip("_")


class LocalEmbeddings:
    """fastembed ONNX model on CPU. No key, no network after the first model download."""

    # BGE v1.5 models retrieve better when queries (not passages) carry this instruction.
    BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

    def __init__(self, model: str, cache_dir: str, batch_size: int = 64):
        from fastembed import TextEmbedding

        self.model = model
        self._m = TextEmbedding(model_name=model, cache_dir=cache_dir)
        self.batch_size = batch_size
        self.dims = len(next(iter(self._m.embed(["probe"]))))

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return [v.tolist() for v in self._m.embed(list(texts), batch_size=self.batch_size)]

    def embed_query(self, text: str) -> list[float]:
        prefix = self.BGE_QUERY_PREFIX if "bge" in self.model.lower() else ""
        return next(iter(self._m.embed([prefix + text]))).tolist()


class OpenAIEmbeddings:
    DIMS = {"text-embedding-3-small": 1536, "text-embedding-3-large": 3072, "text-embedding-ada-002": 1536}

    def __init__(self, model: str, api_key: str, batch_size: int = 64):
        import openai

        self._openai = openai
        self._client = openai.OpenAI(api_key=api_key, max_retries=0, timeout=60)
        self.model = model
        self.batch_size = batch_size
        self.dims = self.DIMS.get(model) or len(self._embed(["probe"])[0])

    def _embed(self, texts: list[str]) -> list[list[float]]:
        o = self._openai
        for attempt in range(4):
            try:
                res = self._client.embeddings.create(model=self.model, input=texts)
                return [d.embedding for d in sorted(res.data, key=lambda d: d.index)]
            except o.RateLimitError as e:
                # A 429 is either throttling (retry) or an account without credit (retrying never helps).
                body = e.body if isinstance(e.body, dict) else {}
                if (getattr(e, "code", None) or body.get("code")) in QUOTA_CODES or body.get("type") == "insufficient_quota":
                    raise RuntimeError(
                        "The OpenAI account has no credit left for embeddings. Add credit, or set "
                        "EMBEDDING_PROVIDER=local in backend/.env to use the free local model."
                    ) from e
                if attempt == 3:
                    raise TransientError(f"Embedding provider unavailable: {e.__class__.__name__}") from e
                time.sleep(2 ** attempt)
            except (o.APIConnectionError, o.APITimeoutError, o.InternalServerError) as e:
                if attempt == 3:
                    raise TransientError(f"Embedding provider unavailable: {e.__class__.__name__}") from e
                time.sleep(2 ** attempt)
            except o.AuthenticationError as e:
                raise RuntimeError("The OpenAI API key was rejected. Check OPENAI_API_KEY in backend/.env.") from e
        raise AssertionError("unreachable")

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            out.extend(self._embed(list(texts[i : i + self.batch_size])))
        return out

    def embed_query(self, text: str) -> list[float]:
        return self._embed([text])[0]


@dataclass
class SparseVector:
    indices: list[int]
    values: list[float]


class BM25Encoder:
    """Term-frequency sparse vectors; Qdrant applies IDF at query time (modifier=idf), giving BM25 scores."""

    MODEL = "Qdrant/bm25"

    def __init__(self, cache_dir: str):
        from fastembed import SparseTextEmbedding

        self._m = SparseTextEmbedding(model_name=self.MODEL, cache_dir=cache_dir)

    def embed_documents(self, texts: Sequence[str]) -> list[SparseVector]:
        return [SparseVector(e.indices.tolist(), e.values.tolist()) for e in self._m.embed(list(texts))]

    def embed_query(self, text: str) -> SparseVector:
        e = next(iter(self._m.query_embed(text)))
        return SparseVector(e.indices.tolist(), e.values.tolist())


def make_embedder(settings: Settings) -> EmbeddingProvider:
    key = settings.openai_api_key.get_secret_value() if settings.openai_api_key else ""
    choice = settings.embedding_provider
    if choice == "openai" or (choice == "auto" and key):
        if not key:
            raise RuntimeError("EMBEDDING_PROVIDER=openai needs OPENAI_API_KEY in backend/.env.")
        return OpenAIEmbeddings(settings.openai_embedding_model, key, settings.embedding_batch_size)
    return LocalEmbeddings(settings.local_embedding_model, str(settings.models_dir), settings.embedding_batch_size)
