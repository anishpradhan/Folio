"""Second-stage reranking: a cross-encoder reads the query and each candidate passage together."""

from __future__ import annotations

from typing import Protocol, Sequence


class Reranker(Protocol):
    model: str

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        """One relevance score per passage, higher is better (scale is model-specific)."""
        ...


class CrossEncoderReranker:
    """fastembed ONNX cross-encoder on CPU (default `Xenova/ms-marco-MiniLM-L-6-v2`, ~90 MB, no key)."""

    def __init__(self, model: str, cache_dir: str, batch_size: int = 16):
        from fastembed.rerank.cross_encoder import TextCrossEncoder

        self.model = model
        self.batch_size = batch_size
        self._m = TextCrossEncoder(model_name=model, cache_dir=cache_dir)

    def score(self, query: str, passages: Sequence[str]) -> list[float]:
        if not passages:
            return []
        return [float(s) for s in self._m.rerank(query, list(passages), batch_size=self.batch_size)]
