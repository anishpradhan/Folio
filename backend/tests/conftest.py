"""Test fixtures: an isolated data dir, a deterministic fake embedder, in-memory Qdrant, and fake parsers
that write real DoclingDocument JSON (so chunking and provenance code run for real, without the layout models)."""

from __future__ import annotations

import hashlib
import math
import re
import threading
import time
from pathlib import Path
from typing import Callable, Iterator

import pytest
from qdrant_client import QdrantClient

from folio_ai.config import Settings
from folio_ai.embeddings import SparseVector
from folio_ai.services import Services
from folio_ai.vectorstore import VectorStore

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"


class FakeEmbedder:
    """Bag-of-words hashing into 64 dims: deterministic, and similar texts get similar vectors."""

    model = "fake-embed-64"
    dims = 64

    def __init__(self) -> None:
        self.calls = 0
        self.fail_times = 0  # raise TransientError this many times first

    def _vec(self, text: str) -> list[float]:
        v = [0.0] * self.dims
        for w in re.findall(r"[a-z0-9]+", text.lower()):
            v[int(hashlib.md5(w.encode()).hexdigest(), 16) % self.dims] += 1.0
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / n for x in v]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        from folio_ai.embeddings import TransientError

        self.calls += 1
        if self.fail_times > 0:
            self.fail_times -= 1
            raise TransientError("Embedding provider unavailable: RateLimitError")
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


class FakeBM25:
    def _sv(self, text: str) -> SparseVector:
        counts: dict[int, float] = {}
        for w in re.findall(r"[a-z0-9]+", text.lower()):
            k = int(hashlib.md5(w.encode()).hexdigest(), 16) % 100_000
            counts[k] = counts.get(k, 0.0) + 1.0
        return SparseVector(list(counts), list(counts.values()))

    def embed_documents(self, texts: list[str]) -> list[SparseVector]:
        return [self._sv(t) for t in texts]

    def embed_query(self, text: str) -> SparseVector:
        return self._sv(text)


class FakeReranker:
    """Fraction of query words present in the passage: deterministic, and different from the fused ranking."""

    model = "fake-rerank"

    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    def score(self, query: str, passages: list[str]) -> list[float]:
        self.calls.append((query, len(passages)))
        q = set(re.findall(r"[a-z0-9]+", query.lower()))
        return [len(q & set(re.findall(r"[a-z0-9]+", p.lower()))) / (len(q) or 1) for p in passages]


class FakeLLM:
    """Scripted LLMProvider. By default it answers in two spans and cites the first block of source 1."""

    model = "fake-llm"

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.completions: list[str] = []
        self.json_calls = 0
        self.script: Callable[[list, str], list] | None = None
        self.rewrite: str | None = None

    def stream_answer(self, *, system, history, sources, prompt, effort):  # type: ignore[no-untyped-def]
        from folio_ai.llm import Citation, Finished, SpanEnd, TextDelta, Thinking

        self.calls.append({"system": system, "history": list(history), "sources": list(sources), "prompt": prompt, "effort": effort})
        events = (
            self.script(list(sources), prompt)
            if self.script
            else [
                Thinking(),
                TextDelta("Lamps were "),
                TextDelta("brighter."),
                Citation(0, 0, 1, sources[0].blocks[0]),
                SpanEnd(),
                TextDelta(" That is all."),
                SpanEnd(),
                Finished("end_turn", self.model, {"input_tokens": 120, "output_tokens": 9}),
            ]
        )
        for ev in events:
            if isinstance(ev, Exception):
                raise ev
            yield ev

    def complete(self, *, system, prompt, effort, max_tokens=2048):  # type: ignore[no-untyped-def]
        self.completions.append(prompt)
        return self.rewrite or "STANDALONE " + prompt.rsplit("Follow-up question: ", 1)[-1]

    def complete_json(self, *, system, prompt, schema, effort, sources=()):  # type: ignore[no-untyped-def]
        self.json_calls += 1
        return schema(questions=["What did the photometer measure?", "How was it calibrated?", "How much brighter were the lamps?", "Why trim the wick?"])


def build_paper(path: str) -> None:
    """A small two-page 'paper' with a title, numbered sections, a subsection and provenance boxes."""
    from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, ProvenanceItem, Size

    doc = DoclingDocument(name="paper")
    for p in (1, 2):
        doc.add_page(page_no=p, size=Size(width=600, height=800))

    def prov(page: int, top: float, text: str) -> ProvenanceItem:
        # Docling's PDF boxes use a bottom-left origin.
        return ProvenanceItem(page_no=page, bbox=BoundingBox(l=60, t=800 - top, r=540, b=800 - top - 40, coord_origin=CoordOrigin.BOTTOMLEFT), charspan=(0, len(text)))

    def text(page: int, top: float, t: str) -> None:
        doc.add_text(label=DocItemLabel.TEXT, text=t, prov=prov(page, top, t))

    doc.add_title(text="Lanterns and Light", prov=prov(1, 40, "Lanterns and Light"))
    doc.add_heading(text="1 Introduction", level=1, prov=prov(1, 100, "1 Introduction"))
    text(1, 150, "Lighthouse keepers trimmed the lantern wick every evening so the beam stayed bright and steady.")
    doc.add_heading(text="2 Method", level=1, prov=prov(1, 300, "2 Method"))
    text(1, 350, "We measured the brightness of paraffin lamps with a photometer at fixed distances.")
    doc.add_heading(text="2.1 Calibration", level=1, prov=prov(1, 500, "2.1 Calibration"))
    text(1, 550, "The photometer was calibrated against a standard candle before each session.")
    doc.add_heading(text="3 Results", level=1, prov=prov(2, 100, "3 Results"))
    text(2, 150, "Paraffin lamps were forty percent brighter after the wick was trimmed.")
    doc.save_as_json(Path(path))


class FakeParser:
    def __init__(self, build: Callable[[str], None] = build_paper):
        self.build = build
        self.calls = 0
        self.fail_with: Exception | None = None
        self.delay = 0.0

    def parse(self, pdf_path: str, out_json: str, on_progress: Callable[[int, int], None] | None = None) -> None:
        self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        if self.fail_with is not None:
            raise self.fail_with
        self.build(out_json)
        if on_progress:
            on_progress(1, 2)
            on_progress(2, 2)
        self.progress_reported = on_progress is not None

    def cancel(self) -> None:
        pass


TEST_DB = "folio_ai_test"
TABLES = "messages, conversations, chunks, sections, ingestion_jobs, documents"


def test_settings(data_dir: Path) -> Settings:
    """Real Postgres credentials from backend/.env, but the separate test database and a temp data dir."""
    return Settings(
        data_dir=data_dir, postgres_db=TEST_DB, database_url=None, embedding_provider="local", openai_api_key=None,
        llm_provider="anthropic", anthropic_api_key=None, gemini_api_key=None, llm_fake=False,
        quick_index=False,  # tests of the quick pass turn it on
    )


@pytest.fixture(scope="session")
def test_database() -> str:
    """Create (once) and migrate the test database in the docker compose Postgres."""
    import psycopg

    from folio_ai.db import migrate

    base = Settings(postgres_db="postgres", database_url=None)
    try:
        with psycopg.connect(base.db_url.replace("postgresql+psycopg", "postgresql"), autocommit=True, connect_timeout=5) as conn:
            if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (TEST_DB,)).fetchone():
                conn.execute(f'CREATE DATABASE "{TEST_DB}"')
    except psycopg.OperationalError as e:
        pytest.exit(f"PostgreSQL is not reachable; start it with `npm run ai:db`. ({e})", returncode=2)
    url = test_settings(Path(".")).db_url
    migrate(url)
    return url


@pytest.fixture
def settings(tmp_path: Path, test_database: str) -> Iterator[Settings]:
    from sqlalchemy import create_engine, text

    s = test_settings(tmp_path / "data")
    s.ensure_dirs()
    engine = create_engine(test_database)
    with engine.begin() as c:
        c.execute(text(f"TRUNCATE {TABLES} CASCADE"))
    engine.dispose()
    yield s


@pytest.fixture
def fake_embedder() -> FakeEmbedder:
    return FakeEmbedder()


@pytest.fixture
def fake_reranker() -> FakeReranker:
    return FakeReranker()


@pytest.fixture
def fake_llm() -> FakeLLM:
    return FakeLLM()


@pytest.fixture
def services(settings: Settings, fake_embedder: FakeEmbedder, fake_reranker: FakeReranker, fake_llm: FakeLLM) -> Iterator[Services]:
    store = VectorStore(settings, fake_embedder.model, fake_embedder.dims, client=QdrantClient(":memory:"))
    sv = Services(settings, embedder=fake_embedder, store=store, reranker=fake_reranker, llm=fake_llm)
    sv.__dict__["bm25"] = FakeBM25()
    yield sv
    sv.close()


@pytest.fixture
def pdf_bytes() -> bytes:
    return (FIXTURES / "plain-notes.pdf").read_bytes()


def wait_for(pred: Callable[[], bool], timeout: float = 20.0, step: float = 0.05) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return
        time.sleep(step)
    raise AssertionError("condition not met in time")


__all__ = ["FakeEmbedder", "FakeParser", "FakeBM25", "FakeReranker", "FakeLLM", "build_paper", "wait_for", "FIXTURES", "threading"]
