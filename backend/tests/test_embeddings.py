"""OpenAI embedding errors: an account without credit fails at once with advice; throttling is retried."""

from typing import Any

import httpx
import openai
import pytest

import folio_ai.embeddings as emb
from folio_ai.embeddings import OpenAIEmbeddings, TransientError


def rate_limit(code: str, type_: str) -> openai.RateLimitError:
    body = {"message": "nope", "type": type_, "code": code}
    response = httpx.Response(429, request=httpx.Request("POST", "https://api.openai.com/v1/embeddings"), json={"error": body})
    return openai.RateLimitError("429", response=response, body=body)


class FailingClient:
    def __init__(self, error: Exception) -> None:
        self.error = error
        self.calls = 0
        self.embeddings = self

    def create(self, **_: Any) -> None:
        self.calls += 1
        raise self.error


def provider(error: Exception) -> tuple[OpenAIEmbeddings, FailingClient]:
    p = object.__new__(OpenAIEmbeddings)
    client = FailingClient(error)
    p._openai, p._client, p.model, p.batch_size = openai, client, "text-embedding-3-small", 64
    return p, client


def test_exhausted_credit_is_permanent_with_advice() -> None:
    p, client = provider(rate_limit("credit_balance_exhausted", "insufficient_quota"))
    with pytest.raises(RuntimeError, match="no credit left.*EMBEDDING_PROVIDER=local"):
        p.embed_documents(["x"])
    assert client.calls == 1  # not retried


def test_throttling_is_retried_then_transient(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(emb.time, "sleep", lambda s: None)
    p, client = provider(rate_limit("rate_limit_exceeded", "requests"))
    with pytest.raises(TransientError):
        p.embed_documents(["x"])
    assert client.calls == 4
