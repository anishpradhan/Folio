"""Long-lived, lazily created heavy objects (embedding models, vector store), shared by the API and worker."""

from __future__ import annotations

import logging
import threading
import time
from functools import cached_property
from typing import TYPE_CHECKING

from .config import Settings
from .embeddings import BM25Encoder, EmbeddingProvider, make_embedder
from .vectorstore import VectorStore

if TYPE_CHECKING:
    from .llm import LLMProvider
    from .retrieval.reranker import Reranker

log = logging.getLogger("folio_ai")
RERANKER_RETRY_S = 60.0


class Services:
    def __init__(
        self,
        settings: Settings,
        embedder: EmbeddingProvider | None = None,
        store: VectorStore | None = None,
        reranker: Reranker | None = None,
        llm: LLMProvider | None = None,
    ):
        self.settings = settings
        self._llm = llm
        self._embedder = embedder
        self._store = store
        self._reranker = reranker
        self._reranker_failed_at = 0.0
        self._init_lock = threading.Lock()
        # Embedded Qdrant and the ONNX sessions are used from the worker thread and request threads.
        self.lock = threading.RLock()

    @cached_property
    def embedder(self) -> EmbeddingProvider:
        with self._init_lock:
            return self._embedder or make_embedder(self.settings)

    @cached_property
    def bm25(self) -> BM25Encoder:
        with self._init_lock:
            return BM25Encoder(str(self.settings.models_dir))

    @cached_property
    def store(self) -> VectorStore:
        emb = self.embedder
        with self._init_lock:
            return self._store or VectorStore(self.settings, emb.model, emb.dims)

    def get_reranker(self) -> Reranker | None:
        """The cross-encoder (loaded on first use), or None when it couldn't load; search then skips reranking.
        A failed load (e.g. out of memory) is retried after a minute rather than on every request."""
        if self._reranker is not None:
            return self._reranker
        if time.monotonic() - self._reranker_failed_at < RERANKER_RETRY_S and self._reranker_failed_at:
            return None
        with self._init_lock:
            if self._reranker is None:
                try:
                    from .retrieval.reranker import CrossEncoderReranker

                    self._reranker = CrossEncoderReranker(self.settings.reranker_model, str(self.settings.models_dir))
                except Exception:  # noqa: BLE001 — retrieval still works without it
                    log.exception("reranker %s failed to load; searching without it", self.settings.reranker_model)
                    self._reranker_failed_at = time.monotonic()
        return self._reranker

    @property
    def llm_configured(self) -> bool:
        if self._llm is not None or self.settings.llm_fake:
            return True
        if self.settings.llm_provider == "gemini":
            from .llm.gemini import has_gemini_credentials

            return has_gemini_credentials(self.settings)
        from .llm.claude import has_credentials

        return has_credentials(self.settings)

    def get_llm(self) -> LLMProvider:
        """The answer model (created on first use). Callers check `llm_configured` first."""
        if self._llm is None:
            with self._init_lock:
                if self._llm is None:
                    from .llm import make_llm

                    self._llm = make_llm(self.settings)
        return self._llm

    def close(self) -> None:
        if "store" in self.__dict__:
            self.store.close()
