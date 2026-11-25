"""`python -m folio_ai.e2e` — a hermetic backend for the Playwright tests (`npm run test:e2e`).

Separate from the reader's own data: database `folio_ai_e2e` (created if missing, emptied on start), data
directory `backend/data/e2e` (wiped on start), port 8766, the scripted LLM and local embeddings. Downloaded
models are shared with the normal backend. Real parsing (Docling), chunking, embedding and retrieval run."""

from __future__ import annotations

import logging
import os
import shutil
import sys

from .config import BACKEND_DIR

E2E_DB = "folio_ai_e2e"
E2E_PORT = "8766"


def main() -> None:
    data_dir = BACKEND_DIR / "data" / "e2e"
    os.environ.update(
        POSTGRES_DB=E2E_DB,
        DATABASE_URL="",
        DATA_DIR=str(data_dir),
        MODELS_PATH=str(BACKEND_DIR / "data" / "models"),
        PORT=E2E_PORT,
        LLM_FAKE="true",
        EMBEDDING_PROVIDER="local",
        OPENAI_API_KEY="",
        ANTHROPIC_API_KEY="",
    )
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    import psycopg
    from sqlalchemy import create_engine, text

    from .__main__ import database_reachable
    from .config import Settings
    from .db import migrate

    s = Settings()
    admin = Settings(postgres_db="postgres").db_url.replace("postgresql+psycopg", "postgresql")
    problem = database_reachable(admin.replace("postgresql://", "postgresql+psycopg://"))
    if problem:
        print(problem, file=sys.stderr)
        sys.exit(1)
    with psycopg.connect(admin, autocommit=True) as conn:
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (E2E_DB,)).fetchone():
            conn.execute(f'CREATE DATABASE "{E2E_DB}"')
    migrate(s.db_url)
    engine = create_engine(s.db_url)
    with engine.begin() as c:
        c.execute(text("TRUNCATE messages, conversations, chunks, sections, ingestion_jobs, documents CASCADE"))
    engine.dispose()
    shutil.rmtree(data_dir, ignore_errors=True)

    import uvicorn

    uvicorn.run("folio_ai.app:create_app", factory=True, host=s.host, port=s.port, log_level="warning")


if __name__ == "__main__":
    main()
