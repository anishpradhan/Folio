"""Backend settings, read from environment variables and `backend/.env`. Keys never leave this process."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8765

    data_dir: Path = BACKEND_DIR / "data"
    # PostgreSQL (docker compose). DATABASE_URL wins; otherwise it is built from the POSTGRES_* values
    # that docker-compose.yml also reads, so the password lives in one place.
    database_url: str | None = None
    postgres_user: str = "folio"
    postgres_password: SecretStr | None = None
    postgres_db: str = "folio_ai"
    postgres_host: str = "127.0.0.1"
    postgres_port: int = 5432
    # Answers: Claude (Anthropic API) or Gemini (Google's Gemini API, which has a free tier). Keys never
    # leave this process.
    llm_provider: Literal["anthropic", "gemini"] = "anthropic"
    anthropic_api_key: SecretStr | None = None
    llm_model: str = "claude-opus-5-5"
    gemini_api_key: SecretStr | None = None
    gemini_model: str = "gemini-3.5-flash-lite"  # stable; the most generous free-tier quota
    llm_effort: Literal["low", "medium", "high", "xhigh", "max"] = "medium"  # answers
    llm_aux_effort: Literal["low", "medium", "high", "xhigh", "max"] = "low"  # follow-up rewriting, suggestions
    llm_fallbacks: bool = True  # server-side refusal fallbacks (`fallbacks: "default"`)
    # A scripted model instead of Claude, for end-to-end tests and demos without a key. Never on by default.
    llm_fake: bool = False
    chat_history_turns: int = 6  # earlier question/answer pairs sent with a follow-up
    chat_passages: int = 8  # retrieved passages per answer (hybrid hit@8 = 1.0 on the eval set)

    # Embedded Qdrant (on-disk) by default; set QDRANT_URL to use a Qdrant server instead.
    qdrant_url: str | None = None
    qdrant_api_key: SecretStr | None = None

    # Embeddings: "auto" uses OpenAI when a key is configured, otherwise the local model.
    embedding_provider: Literal["auto", "openai", "local"] = "auto"
    openai_api_key: SecretStr | None = None
    openai_embedding_model: str = "text-embedding-3-small"
    local_embedding_model: str = "BAAI/bge-small-en-v1.5"
    embedding_batch_size: int = 64

    # Retrieval
    # Off by default: on the eval set it ranked one more question first but cost 1-3 s per query on this CPU
    # (docs/ai/architecture.md §10). Requests can still ask for it with `rerank: true`.
    rerank_by_default: bool = False
    reranker_model: str = "Xenova/ms-marco-MiniLM-L-6-v2"
    rerank_candidates: int = 12  # fused hybrid candidates the cross-encoder rescores (~120 ms each on CPU)
    context_budget_tokens: int = 6000  # passages handed to the LLM per answer (phase 3)

    # Ingestion
    max_upload_bytes: int = 600 * 1024 * 1024
    # A parse stops when no page finishes for parse_stall_s, or after parse_timeout_s in total (a long book on
    # a laptop CPU can take an hour). The Docling process stays loaded for parse_keep_warm_s after a document
    # (0: a fresh process per document) so uploads in a row skip the model start-up.
    parse_timeout_s: int = 4 * 3600
    parse_stall_s: int = 600
    parse_keep_warm_s: int = 300
    parse_threads: int = 4
    # Docling table structure recognition (slower, much better tables). OCR only runs for pages without text.
    parse_tables: bool = True
    # Make a document answerable from its text layer within seconds, before Docling reads the layout (§18).
    quick_index: bool = True
    # Docling layout preset: layout_egret_medium reads ~25% faster than the default layout_heron_default with
    # the same structure on research papers (docs/ai/architecture.md §17); layout_egret_large is slower, finer.
    parse_layout_model: str = "layout_egret_medium"
    chunk_max_tokens: int = 512
    max_auto_retries: int = 3
    # Bump when chunking/indexing changes so documents are re-ingested (3: citation blocks per item).
    pipeline_version: int = 3
    # Bump only when Docling parsing itself changes; the parse cache is keyed by it, so re-chunking is fast.
    parse_version: int = 1

    @property
    def answer_model(self) -> str:
        if self.llm_fake:
            return "scripted-test-model"
        return self.gemini_model if self.llm_provider == "gemini" else self.llm_model

    @property
    def llm_key_name(self) -> str:
        return "GEMINI_API_KEY" if self.llm_provider == "gemini" else "ANTHROPIC_API_KEY"

    @property
    def use_openai_embeddings(self) -> bool:
        key = bool(self.openai_api_key and self.openai_api_key.get_secret_value())
        return self.embedding_provider == "openai" or (self.embedding_provider == "auto" and key)

    @property
    def embedding_model(self) -> str:
        return self.openai_embedding_model if self.use_openai_embeddings else self.local_embedding_model

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        from urllib.parse import quote

        pw = quote(self.postgres_password.get_secret_value(), safe="") if self.postgres_password else ""
        auth = f"{quote(self.postgres_user, safe='')}:{pw}" if pw else quote(self.postgres_user, safe="")
        return f"postgresql+psycopg://{auth}@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    @property
    def parsed_dir(self) -> Path:
        return self.data_dir / "parsed"

    @property
    def qdrant_path(self) -> Path:
        return self.data_dir / "qdrant"

    # Downloaded models (Docling, embeddings); defaults to <data_dir>/models. The e2e backend shares them.
    models_path: Path | None = None

    @property
    def models_dir(self) -> Path:
        return self.models_path or self.data_dir / "models"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.files_dir, self.parsed_dir, self.models_dir):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
