"""End to end with the real components: Docling (child process), local embeddings, BM25, embedded Qdrant."""

import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from folio_ai.app import create_app
from folio_ai.config import Settings
from tests.conftest import FIXTURES, wait_for

pytestmark = pytest.mark.slow

SHARED_MODELS = Settings().models_dir  # reuse downloaded models across test runs


class SharedModelSettings(Settings):
    @property
    def models_dir(self) -> Path:  # type: ignore[override]
        return SHARED_MODELS


def test_real_ingestion_of_a_pdf(settings: Settings) -> None:
    s = SharedModelSettings(**{k: getattr(settings, k) for k in ("data_dir", "postgres_db", "embedding_provider")}, database_url=None, openai_api_key=None)
    pdf = (FIXTURES / "quiet-art.pdf").read_bytes()
    digest = hashlib.sha256(pdf).hexdigest()
    with TestClient(create_app(s)) as c:
        r = c.post("/api/ai/documents", files={"file": ("quiet-art.pdf", pdf, "application/pdf")}, data={"sha256": digest})
        assert r.status_code == 202
        doc: dict = {}

        def done() -> bool:
            doc.update(c.get(f"/api/ai/documents/{digest}").json())
            return doc["status"] in ("ready", "failed")

        wait_for(done, timeout=600, step=1)
        assert doc["status"] == "ready", (doc["error"], doc.get("job"))
        assert doc["embeddingModel"] == "BAAI/bge-small-en-v1.5"
        chunks = c.get(f"/api/ai/documents/{digest}/chunks").json()["items"]
        assert chunks and all(1 <= ch["pageStart"] <= doc["pageCount"] for ch in chunks)
        assert all(ch["locations"] for ch in chunks)
        # A passage's own words find it again.
        target = max(chunks, key=lambda ch: len(ch["text"]))
        words = " ".join(target["text"].split()[:15])
        hits = c.post(f"/api/ai/documents/{digest}/search", json={"query": words, "limit": 3}).json()["hits"]
        assert target["id"] in [h["id"] for h in hits]
