# Folio AI backend

FastAPI service that prepares documents for AI question answering. It parses each PDF with Docling,
splits it into structure-aware passages, embeds them, and indexes them in Qdrant for hybrid dense + BM25
search. The design is in [`docs/ai/architecture.md`](../docs/ai/architecture.md).

The reader works exactly as before without this service. It runs on `127.0.0.1:8765`, and browsers
(including other devices on your network) reach it only through the Vite dev/preview proxy at `/api/ai`.

## Setup (once)

```bash
py -3.13 -m venv backend/.venv                       # Windows; python3 -m venv elsewhere
backend/.venv/Scripts/python -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
backend/.venv/Scripts/python -m pip install -r backend/requirements.txt
cp backend/.env.example backend/.env                 # set POSTGRES_PASSWORD, LLM_PROVIDER and its key
npm run ai:db                                        # PostgreSQL 17 in Docker (Docker Desktop must be running)
```

Metadata, jobs and chats live in PostgreSQL (the `folio-ai` compose project, port 5432 on loopback
only, data in the `folio_pg` volume). The backend applies Alembic migrations on start-up. After changing
the models in `db.py`, generate a migration from `backend/`:

```bash
.venv/Scripts/python -m alembic revision --autogenerate -m "describe the change"
```

`requirements.lock.txt` lists the exact versions the tests passed with.

The first ingestion downloads the Docling layout and table models and the local embedding model into
`backend/data/models` (about 0.6 GB).

## Answer model

| `LLM_PROVIDER` | Key | Notes |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | Claude Opus 5.5; citations from Claude's citation API; refusal fallbacks |
| `gemini` | `GEMINI_API_KEY` (free at https://aistudio.google.com/apikey) | `gemini-3.5-flash-lite` by default (`GEMINI_MODEL`); free-tier daily limits apply, and on the free tier Google may use prompts to improve its products |

Restart the backend after changing it. See `docs/ai/architecture.md` §13 for how Gemini citations work.

## Run

```bash
npm run ai:db       # start PostgreSQL (once per boot; `npm run ai:db:stop` stops it)
npm run ai          # backend on 127.0.0.1:8765
npm run dev         # the app; /api/ai/* is proxied to the backend
npm run test:ai     # backend tests (fast); add `-m slow` to run the real Docling pipeline
npm run test:e2e    # Playwright, including the Ask tab against a hermetic backend (below)
```

`npm run test:e2e` starts its own backend with `node scripts/ai.mjs e2e`: port 8766, database `folio_ai_e2e`,
data folder `backend/data/e2e` (both emptied at start), real parsing and retrieval, and a scripted model
(`LLM_FAKE=true`) instead of Claude, so no key or credit is needed. Set `FOLIO_E2E_AI=0` to skip it.

Tests use a separate `folio_ai_test` database in the same container, created and migrated once per run.

Docling needs about 2 GB of free memory to load its models. If the computer runs out, the document
fails with an out-of-memory message and is retried automatically (after 15 s, 60 s, then 240 s).

With no `OPENAI_API_KEY`, embeddings use `BAAI/bge-small-en-v1.5` locally on the CPU (no key, no cost).
With a key, `text-embedding-3-small` is used. Each model has its own Qdrant collection, and documents
indexed with another model are re-ingested when uploaded again.

## API (phases 1–3)

| Method | Path | |
| --- | --- | --- |
| GET | `/api/ai/health` | Status, embedding provider/model, document counts. Never returns keys. |
| POST | `/api/ai/documents` | multipart `file` (+ `sha256`, `title`). Returns 202 if queued, 200 if it is already ready or in progress. The id is the SHA-256 of the file (the browser's `fileHash`). |
| GET | `/api/ai/documents/{id}` | Status (`queued → parsing → chunking → embedding → indexing → ready` or `failed`), progress, detail, error, latest job, and `index` (`quick` while answering from the text layer, `full` from Docling) with `refining` (the full pass is still to come). |
| GET | `/api/ai/documents/{id}/events` | Server-sent `status` events until failed, or ready with the full pass done. |
| POST | `/api/ai/documents/{id}/retry[?force=true]` | Re-queue a failed document, or rebuild a ready one. |
| DELETE | `/api/ai/documents/{id}` | Remove the file, parse cache, passages and vectors. |
| GET | `/api/ai/documents/{id}/sections` · `/chunks` | The heading tree, and passages with pages and normalised rectangles. |
| POST | `/api/ai/documents/{id}/search` | `{query, section_id?, page_start?, page_end?, limit?, mode: hybrid\|dense\|bm25, rerank?}`. Hits carry `rank`, `score`, `fusedScore`, `rerankScore`. |
| POST | `/api/ai/documents/{id}/related` | `{text, page?, limit?, section_id?…}`: locates the selection's own passage (`selection`, with `match`) and returns other passages related to it. |
| GET | `/api/ai/documents/{id}/suggestions` | Four starter questions (generated once with Claude, then stored). |
| POST · GET | `/api/ai/documents/{id}/conversations` | Create (`{title?}`) or list a document's conversations (most recent first, with message counts). |
| GET · DELETE | `/api/ai/conversations/{cid}` | A conversation with its messages (content, citations, status, retrieval details), or delete it. |
| POST | `/api/ai/conversations/{cid}/messages` | `{content, mode: chat\|ask\|explain\|summarize\|simplify, selection?: {text, page}, section_id?, page_start?, page_end?}` → server-sent events `start`, `sources`, `status`, `delta`, `citation`, `done` / `error` (see `folio_ai/chat/service.py`). 503 until `ANTHROPIC_API_KEY` is set. |
| POST | `/api/ai/documents/{id}/context` | Search + context assembly: numbered sources `[n]` in reading order, neighbours merged, within `budget_tokens`. What phase 3 sends to the model. |

## Layout

```
folio_ai/
  config.py        settings (.env)            db.py          SQLAlchemy models (PostgreSQL) + migrate()
  documents.py     upload, hashing, delete    services.py    shared embedder / BM25 / vector store
  embeddings.py    OpenAI + local + BM25      vectorstore.py Qdrant: dense + sparse, scoped hybrid search
  app.py           FastAPI routes + SSE       __main__.py    `python -m folio_ai`
  ingestion/
    parsing.py     Docling in a child process (timeout, cancel, memory isolation)
    chunking.py    section tree + HybridChunker + provenance rectangles
    quick.py       quick pass: text-layer paragraphs (pdfium) → passages, answerable in seconds
    pipeline.py    stages and status          worker.py      job queue (quick + full workers), retries, recovery
```
