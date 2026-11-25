# Folio AI — document Q&A architecture

Status: **Phases 1 (ingestion), 2 (retrieval), 3 (generation + chat backend), 4 (document chat UI),
5 (selection assistant) and 6 (save to notes) are implemented and verified** (see §9–§12, §14 and §15; the
live Claude check in §11 is pending API credit, and answers were checked live with Gemini, §13). Phases 7–8
are designed here but not built yet. Sections marked _(measured)_ were benchmarked on the development
machine (Intel i5-8365U, 4 cores, 8 GB RAM, no GPU, Windows 10).

---

## 1. Assessment of the existing codebase

Folio is a **local-first single-page app** (React 18 + TypeScript + Vite, zustand, Tailwind). There is
no backend except two Vite middlewares (the link-import proxy in `server/linkProxy.ts`). Everything the
user owns lives in the browser's IndexedDB.

| Area | What exists | Reuse for AI |
| --- | --- | --- |
| Document management | `data/db.ts`, `data/repo.ts`: `documents` (metadata, outline, page sizes, cover, reading position), `files` (original bytes), soft-delete + purge, collections. Ingest (`core/ingest.ts`) validates, sniffs format, de-duplicates by **SHA-256 content hash** (`fileHash`). | The hash becomes the **cross-system document identity**. The backend never manages the library; it only receives a copy of the bytes for indexing. |
| PDF parsing (client) | pdf.js rendering, text layer, `core/pdf/indexText.ts` → `PageTextRecord` per page (reading-order text, paragraph breaks, deepest outline section). | Stays the source for on-screen search, reflow view, and **resolving citation quotes to exact on-page rectangles** (`core/text/search.ts` `indexTextLayer` + `rangeFor`). It is not good enough for retrieval structure (no headings, tables, columns or captions), so it isn't sent to the backend. |
| EPUB | `core/epub/*`: sections addressed like pages (1-based), text anchors as folded-text offsets. | Phase 7: section XHTML → backend HTML parsing; citations use `page = section` + text anchor. |
| Annotations | `Highlight` (page + **normalised rects 0..1, top-left origin** + text + note), `Bookmark`, `PageNote`, `JournalEntry`; flash-on-arrival (`flashHighlight`), Insights page. | Citations use the same `(page, NormRect[])` addressing, so the existing highlight overlay and flash animation can show a cited passage. **Save to notes** writes ordinary `PageNote`s / highlight notes / journal entries, so they appear in Insights and Markdown export for free. |
| Reader | `useReader` store; `nav.goTo(page, { y })` navigator registered by every layout; `selection: SelectionInfo` (text, per-page parts with rects, surrounding sentence); `SelectionToolbar` popover; right sidebar with tabs. | The assistant hooks into `SelectionInfo` (no new selection code). The chat becomes a right-sidebar tab. Citations navigate with `nav.goTo`. |
| Placeholders | `src/ai/contracts.ts` (interfaces, unused). | Replaced by a real client (`src/ai/`). Chunking, embedding and vector storage move to the backend (see §2). |

**Constraints that shape the design**

* Documents are private and local. The AI feature must be **opt-in per document** and say clearly that
  the text goes to the backend and to the configured model provider.
* The reader also uses Folio from an Android tablet over the LAN. Each device has its **own IndexedDB**
  (different `docId`s for the same book), but the content hash is the same. The backend therefore keys
  documents and chats by **hash**: a book indexed on the laptop is ready on the tablet, and chats follow it.
* Browser code must never see API keys. Only the backend holds them.

---

## 2. Backend architecture

```
Browser (React)                     Vite dev/preview server            Python backend (FastAPI, 127.0.0.1:8765)
──────────────                      ───────────────────────            ─────────────────────────────────────────
 src/ai/client.ts  ── /api/ai/* ──▶  proxy (same origin, LAN-safe) ──▶  api/        HTTP + SSE routes
                                                                        documents/  registration, files, status   (1)
                                                                        ingestion/  job queue + worker            (2)
                                                                          parsing     Docling → DocElements
                                                                          chunking    hierarchical chunker        (3)
                                                                        embeddings/ provider abstraction          (3)
                                                                        vectorstore/ Qdrant (dense + BM25)        (4)
                                                                        retrieval/  hybrid search, rerank         (5)
                                                                        llm/        provider abstraction          (6)
                                                                        chat/       conversations, prompts        (7)
                                                                        db/         SQLAlchemy models, sessions
```

The numbers match the responsibilities the spec says to keep separate; (8), the frontend integration,
lives in `src/ai/` and the reader. Each package exposes a small interface (`Parser`, `Chunker`,
`EmbeddingProvider`, `VectorStore`, `Retriever`, `Reranker`, `LLMProvider`). Swapping, say, OpenAI
embeddings for a local model is a config change. The abstraction stops there: one implementation per
interface unless a second one is actually needed.

### Technology decisions

| Proposed | Decision | Why |
| --- | --- | --- |
| Docker | **PostgreSQL runs in Docker (`backend/docker-compose.yml`); the Python backend and Docling run natively.** | The user asked for Postgres in Docker (2026-11-17). Docling, the heaviest component, runs in a venv: inside Docker Desktop's VM it would compete for the same 8 GB, and the VM itself already takes ~2 GB. A full compose file (backend + Qdrant + Postgres) is phase 8. |
| Python + FastAPI | **Adopted.** | Docling, fastembed and the Qdrant client are Python-first. FastAPI streams SSE natively and gives typed request/response models. |
| Docling | **Adopted for PDFs (CPU, OCR off unless a page has no text layer).** _(measured, see §4)_ | Layout-aware reading order (two-column papers), headings, section hierarchy, tables, captions and formulas. **Per-item provenance (page + bounding box)** is exactly what citations need. pdf.js text (client) has none of this. |
| Hierarchical chunking | **Adopted: Docling `HybridChunker`** (structure-first, token-aware). | Splits on the document tree and keeps each chunk's heading path. It merges small siblings and splits oversized items with the embedding model's tokenizer. Chunks never straddle sections. |
| `text-embedding-3-small` | **Adopted when `OPENAI_API_KEY` is set. Local fallback: `BAAI/bge-small-en-v1.5` (fastembed, ONNX, CPU).** | The local model lets ingestion run and be tested with no key and no cost. Vectors from different models never mix: the Qdrant collection name includes the model. |
| Qdrant | **Adopted. Embedded mode by default (on-disk, in-process); `QDRANT_URL` switches to a server.** | One store holds the dense vectors, BM25 sparse vectors and payload filters (document, section, page). Embedded mode needs no extra service at single-user scale. The same client API works against a Qdrant server or Docker later. |
| PostgreSQL | **PostgreSQL 17 in Docker** (`backend/docker-compose.yml`, `npm run ai:db`), SQLAlchemy 2 + psycopg 3, Alembic migrations applied on start-up. | Bound to loopback, 512 MB limit, credentials from `backend/.env`. JSONB for structured columns; job claiming uses `FOR UPDATE SKIP LOCKED`. Full-text search stays in Qdrant. _(Changed from the original SQLite default at the user's request, 2026-11-17.)_ |
| Hybrid dense + BM25 | **Adopted: Qdrant sparse vectors (`Qdrant/bm25` via fastembed, IDF modifier) + dense, fused with RRF in Qdrant's Query API.** | Dense search handles paraphrase. BM25 handles exact terms, symbols, acronyms and numbers, which are common in research papers. |
| LLM provider abstraction | **Adopted: `LLMProvider` (`stream_answer` → text, citation and span events; `complete`; `complete_json`) with two implementations, chosen by `LLM_PROVIDER`: Claude (`claude-opus-5-5`, Anthropic SDK) and Gemini (`gemini-3.5-flash-lite`, google-genai SDK, free tier).** | The interface carries sources as documents of numbered blocks and returns citations as block ranges. Claude gets them from its citation API. Gemini has none, so its provider labels each sentence `[source.sentence]` in the prompt and turns the labels the model writes back into the same citation events (§13). Grok was considered, but xAI's API has no free tier. |
| Reranking | **Built (2b): local cross-encoder (fastembed `Xenova/ms-marco-MiniLM-L-6-v2`) behind a `Reranker` interface, but off by default; a request opts in with `rerank: true`.** _(measured, §10)_ | The estimate of 100–300 ms for 30 candidates was wrong: on this CPU it costs ~120 ms per passage (3.5–4.6 s for 30, 1.75 s for 12). On the eval set it ranked one more question first (hit@1 0.82 → 0.85) and lost none at hit@8, which doesn't justify 1–3 s per query. A hosted reranker (Cohere/Voyage) or a GPU fits behind the same interface. |
| SSE | **Adopted** for chat tokens and ingestion status. | One-way server → client streams over plain HTTP, through the Vite proxy. The client reads `fetch()` streams rather than `EventSource`, because chat requests are POSTs. |
| Job queue | **DB-backed job table + one in-process worker; parsing runs in a child process.** | Celery or arq would need Redis. A job table survives restarts, shows status, and supports retry. The child process isolates Docling's memory and lets a stuck parse be killed on timeout. |

### Security

* API keys live in `backend/.env` (git-ignored). No key is ever returned by any endpoint.
* The backend binds to **127.0.0.1** only. Browsers, including the tablet, reach it through the Vite
  proxy (`/api/ai/*`), the same origin as the app, so there is no CORS and no extra open port.
* Phase 8 adds an optional shared token (`FOLIO_AI_TOKEN`), because anyone on the LAN who can open
  Folio can spend API credits through the proxy.
* Uploads: size cap (600 MB), `%PDF-` magic check, the SHA-256 is recomputed server-side and must match the
  claimed hash, and files are stored under their hash (user filenames never reach the filesystem).
* Prompt injection: document text is untrusted data. The system prompt says so, the model has **no tools**,
  and only citation ids from the provided context are accepted.

---

## 3. Database schema (PostgreSQL, via SQLAlchemy + Alembic)

```
documents                              -- one row per unique file content
  id              TEXT PK              -- sha256 hex of the original bytes (= client fileHash)
  format          TEXT                 -- 'pdf' | 'epub'
  title           TEXT
  file_name       TEXT                 -- display only
  file_size       BIGINT
  page_count      INT NULL
  status          TEXT                 -- queued|parsing|chunking|embedding|indexing|ready|failed
  progress        REAL                 -- 0..1 within the current stage
  status_detail   TEXT NULL            -- human-readable ("Embedding 120 / 340 chunks")
  error           TEXT NULL
  pipeline_version INT                 -- bump to force re-ingestion after chunker/parser changes
  embedding_model TEXT NULL            -- model the stored vectors were made with
  suggested_questions JSONB NULL       -- phase 3
  created_at, updated_at  TIMESTAMP

ingestion_jobs                          -- one row per attempt; history kept for observability
  id              TEXT PK (uuid)
  document_id     TEXT FK → documents.id ON DELETE CASCADE
  status          TEXT                 -- queued|running|succeeded|failed|cancelled
  stage           TEXT NULL            -- last stage reached
  attempt         INT
  error           TEXT NULL
  error_kind      TEXT NULL            -- 'transient' (auto-retried) | 'permanent'
  started_at, finished_at, created_at TIMESTAMP

sections                                -- the document's heading tree (from Docling)
  id              TEXT PK              -- f"{document_id}:s{n}"
  document_id     TEXT FK
  parent_id       TEXT NULL FK → sections.id
  ordinal         INT                  -- document order
  level           INT
  title           TEXT
  page_start, page_end INT

chunks                                  -- canonical chunk text + provenance (Qdrant holds vectors + a payload copy)
  id              TEXT PK              -- f"{document_id}:c{ordinal}" (stable for a pipeline version)
  document_id     TEXT FK
  ordinal         INT
  section_id      TEXT NULL FK → sections.id
  heading_path    JSONB                -- ["3 Method", "3.2 Training"]
  text            TEXT                 -- chunk body as shown to the LLM and the user
  embed_text      TEXT                 -- heading path + captions + body (what was embedded)
  page_start, page_end INT
  locations       JSONB                -- [{page, rect:{x,y,w,h} (normalised, top-left), char_start, char_end}]
  token_count     INT
  kinds           JSONB                -- ["paragraph","table","list_item",…]

conversations
  id              TEXT PK (uuid)
  document_id     TEXT FK
  title           TEXT
  created_at, updated_at TIMESTAMP

messages
  id              TEXT PK (uuid)
  conversation_id TEXT FK ON DELETE CASCADE
  role            TEXT                 -- user|assistant
  content         TEXT
  mode            TEXT                 -- chat|explain|summarize|simplify|ask|related
  scope           JSON                 -- {"kind":"document"|"section"|"selection", section_id?, page?, selection_text?}
  citations       JSON                 -- [{n, chunk_id, page, quote, locations}]
  retrieval       JSON NULL            -- trace: query, candidates + scores (for debugging/eval)
  model           TEXT NULL
  usage           JSON NULL            -- tokens in/out
  created_at      TIMESTAMP
```

**Qdrant collection** `folio_chunks__<embedding-model-slug>`:
* named vectors: `dense` (cosine, model dims) and `bm25` (sparse, `modifier=idf`)
* point id: UUIDv5(chunk id)
* payload: `document_id`, `chunk_id`, `ordinal`, `section_id`, `section_ids` (all ancestors, for
  section-scoped search), `page_start`, `page_end`, `heading_path`, `text`
* payload indexes on `document_id`, `section_ids`, `page_start`

Identity chain, preserved end to end: **document hash → section id → chunk id → page + normalised rect +
char span**. The browser maps the hash back to its local `docId` (`findDocumentByHash`).

---

## 4. Ingestion workflow

```
POST /api/ai/documents  (multipart: file, client metadata)     ──▶ 202 {document, job}
   verify magic + recompute sha256 ─ store data/files/<hash>.pdf ─ upsert documents ─ enqueue job
   (already ready with the same pipeline version → 200, no work)

worker (one at a time, FIFO):
  parsing     Docling (child process, timeout) → DoclingDocument (JSON cached in data/parsed/<hash>.json)
  chunking    HybridChunker(tokenizer=embedding model) → chunks + sections + locations
  embedding   provider.embed(embed_text) in batches (64), retry 429/5xx with backoff
  indexing    delete previous points for the document → upsert dense + bm25 points → status ready

GET  /api/ai/documents/{hash}            status, progress, detail, error, counts
GET  /api/ai/documents/{hash}/events     SSE: status changes until ready/failed
POST /api/ai/documents/{hash}/retry      re-queue a failed (or force a ready) document
DELETE /api/ai/documents/{hash}          remove file, rows, vectors
GET  /api/ai/health                      backend + providers + models (never keys)
```

* **Statuses:** `queued → parsing → chunking → embedding → indexing → ready`, or `failed` with a
  human-readable error. `progress` is per stage; `status_detail` reads like "Embedding 120 / 340 chunks".
* **Errors:** transient ones (network errors, provider 429/5xx) are retried automatically up to 3 times with
  exponential backoff. Permanent ones (corrupt or encrypted file, parse timeout) stop with `failed`. A manual retry
  starts a new attempt. Every attempt is an `ingestion_jobs` row.
* **Restart safety:** on startup, jobs left `running` go back to `queued`.
* **Idempotency:** chunk ids are deterministic, re-indexing deletes the document's points first, and the
  parse is cached per hash, so retrying after an embedding failure skips the slow parse.
* **Location mapping:** Docling provenance bboxes (PDF points, bottom-left origin) become normalised
  top-left rects using Docling's page size. That is the same space as `Highlight.rects`, so citations can be
  drawn with the existing highlight overlay.

---

## 5. Retrieval and generation workflow

**Retrieval (phase 2)**
1. Scope filter: document (always), and optionally section (`section_ids` contains X) or page range.
2. Query: phase 3 adds a *standalone question*, a follow-up rewritten using the last turns (a cheap LLM call)
   so that "what about the second one?" retrieves well.
3. Hybrid search: dense top-40 + BM25 top-40, fused with **RRF** in Qdrant (`prefetch` + `FusionQuery`).
4. Rerank (2b, opt-in): cross-encoder over the fused top-12 → top-k. Off by default (§10).
5. Context assembly: keep passages in relevance order until the token budget (6000) is used. A passage
   that doesn't fit is skipped, but smaller later ones can still go in, and the top passage is always kept.
   Then restore document order, merge adjacent chunks of the same section, and label each source `[n]` with
   its heading path and pages.

Code: `folio_ai/retrieval/` (`Retriever`, `Reranker`, `assemble_context`, `locate_selection`).
Endpoints: `search`, `related` (selection → its own passage + related passages) and `context` (the numbered
sources an answer would use).

**Generation (phase 3)**: each context source is sent as a Claude `document` block with custom content: one
text block per sentence, with citations enabled. The source is titled with its heading path, and its context
says its pages. The system prompt requires answering only from the passages, says to support each claim, and
asks for a plain "the document doesn't say" when they don't answer. It also says passage text is content, not
instructions (the model has no tools). The API returns `content_block_location` citations (source index +
block range + verbatim `cited_text`). Each is resolved to `{source, chunkId, page, locations, quote}` using the
blocks' stored rectangles. Citations naming a source or block that wasn't sent are dropped and counted.
Planned `[n]` markers in the text were replaced by API citations: the quote is guaranteed to be source text,
and a citation covers a span of the answer rather than a marker the model has to place.

* **Citation blocks** are built at ingestion (pipeline v3). Each chunk's text is split into sentence-sized
  blocks, and each block keeps the page boxes of the Docling item it came from. On the paper, a passage that
  starts at the bottom of p. 4 cites its p. 4 footnote and its p. 5 sentences with their own boxes.
* **Follow-ups:** for retrieval, a follow-up is rewritten into a standalone question by a short low-effort call
  that sees the last turns. The answer call gets the last 6 question/answer pairs as plain text (no earlier
  sources) plus fresh sources for this turn. Failed or refused turns are left out of the history.
* **Model settings:** `claude-opus-5-5`, adaptive thinking (always on for this model), effort `medium` for
  answers and `low` for rewriting and suggestions. Server-side refusal fallbacks are on (`fallbacks:
  "default"`): a declined request is retried on a fallback model inside the same stream. If every model
  declines (`stop_reason: refusal`), the partial answer is discarded and the turn is stored as `refused`.
* **No prompt caching:** each turn's sources change and the history is re-sent as plain text, so the prefix
  past the short system prompt is never repeated, and cache writes would only add cost.
* **Suggested questions:** generated once per document from its outline and opening passages (structured
  output, low effort), then stored on the document.

**SSE events** (`POST /api/ai/conversations/{id}/messages`, see `backend/folio_ai/chat/service.py`):
`start` → `sources` (sent before generation so the UI can show them early) → `status: thinking` →
`delta` (text) and `citation` (each with the `[start, end)` span of answer text it supports) … → `done`
(message id, status, usage), or `error` (message, retryable). The user message is stored before generation.
The assistant message is stored when generation ends, including on failure (`error`) and when the reader
closes the stream (`interrupted`, with the partial text).

**Contextual assistant modes** (same endpoint, `mode` + `scope`):

| Mode | Context |
| --- | --- |
| Explain / Summarize / Simplify | The **selected text** plus its surrounding paragraph and heading path (from the chunk containing the selection, found by page + text match). No retrieval. Fast and cheap. |
| Ask (custom question) | Selection + hybrid retrieval (scope: section by default, document optional). |
| Find related passages | **Retrieval only, no LLM:** the selection is the query, its own chunk is excluded, and the result is a list of passages with pages. |
| Section / whole-document chat | Retrieval scoped by `section_ids` or the whole document. |

---

## 6. Frontend integration plan

* `src/ai/api.ts`: typed API client and a `fetch` SSE reader (abortable). `src/ai/store.ts` (zustand):
  backend availability, per-hash document status, conversations, messages, the one streaming answer.
* **Vite proxy** `/api/ai/*` → `http://127.0.0.1:8765` (dev and preview). If the backend is down, AI UI
  shows "Assistant offline" and nothing else changes.
* **Opt-in per document:** the reader's new **Ask** tab (right sidebar, next to the notebook) offers
  "Prepare this document for questions". It uploads the bytes from IndexedDB and shows live ingestion
  status (SSE) with retry. (An auto-prepare preference was not built: preparing costs a Docling parse, so
  it stays a deliberate choice per document.)
* **Document chat:** a conversation list per document; streaming answers; citations rendered as `p. 4`
  chips. Clicking one → `nav.goTo(page, { y })` and a temporary flash overlay. The quote is first matched in
  the page's text layer (`indexTextLayer` / `rangeFor`) for exact rects, with the stored bbox as fallback.
  Suggested questions appear on an empty chat.
* **Selection assistant:** an **Ask AI** button in the existing `SelectionToolbar` opens a card anchored to
  the selection, with the five modes (Explain, Summarize, Simplify, Ask…, Find related). "Continue in chat"
  opens the card's conversation in the Ask tab (built: §14).
* **Save to notes:** from a selection → create a highlight whose note is the explanation. From chat → a
  `PageNote` on the first cited page (with citations as page references), or a Journal entry. All through
  existing repo functions, so they show up in Insights and the Markdown export (built: §15).
* Nothing in the existing reading flow changes when AI is unused or offline.

---

## 7. Phased implementation plan

| Phase | Scope | Verified by |
| --- | --- | --- |
| **1. Infrastructure + ingestion** | FastAPI app, settings, SQLAlchemy models, job worker, upload/status/SSE/retry/delete API, Docling parsing → sections/chunks with locations, embeddings (local + OpenAI), Qdrant hybrid indexing, Vite proxy, `npm run ai`. | pytest: parsing provenance, chunk invariants (pages, heading paths, rect bounds), job lifecycle including failure + retry + restart recovery, API contract. Real ingestion of fixtures and an arXiv paper. |
| **2. Retrieval** | `POST /api/ai/documents/{hash}/search` (scope filters), RRF hybrid, 2b reranker, context assembly. Small eval set (question → expected pages). | Recall@k on the eval set for dense vs BM25 vs hybrid vs hybrid+rerank. |
| **3. Generation + chat backend** | LLM providers (OpenAI, Anthropic), prompts, SSE chat, conversations/messages, citation validation, follow-up rewriting, suggested questions. | Tests with a fake LLM provider (deterministic stream); a live smoke test with a real key. |
| **4. Document chat UI** | Ask tab, opt-in + status, streaming chat, citation navigation + flash, suggested questions. | Playwright against the real backend with a fake provider. |
| **5. Selection assistant** | Toolbar button, five modes, answer card, continue-in-chat. | Playwright (PDF + tablet touch). |
| **6. Save to notes** | Explanation → highlight note / page note / journal; shows in Insights. | Playwright. |
| **7. EPUB** | Section XHTML → Docling HTML backend; citations by section + text anchor. | Pytest + Playwright. |
| **8. Hardening** | Shared token, `docker-compose.yml` (backend + Qdrant + Postgres), Postgres verified, cost/usage display, re-embed on model change. | Compose up + full suite. |

---

## 8. Dependencies and infrastructure

**Backend** (`backend/requirements.txt`, Python 3.13 venv in `backend/.venv`):
`fastapi`, `uvicorn[standard]`, `pydantic-settings`, `sqlalchemy>=2`, `python-multipart`, `docling`
(brings `torch` CPU, `docling-core`, `pypdfium2`), `qdrant-client[fastembed]` (embedded Qdrant, local
dense + BM25 + cross-encoder models via ONNX), `openai` (embeddings, optional LLM), `anthropic` (phase 3),
`httpx`, `pytest`.

**Models downloaded on first use** (cached in `backend/data/models`): Docling layout + TableFormer
(~0.5 GB), fastembed `bge-small-en-v1.5` (~130 MB), `Qdrant/bm25` (tiny), reranker (~90 MB, phase 2b).

**Runtime:** one Python process (API + worker), one Docling child process during parsing, and the
PostgreSQL container (`npm run ai:db`). No Redis or Qdrant server is needed.

**Configuration** (`backend/.env`, see `.env.example`): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`EMBEDDING_PROVIDER` (`openai`|`local`), `LLM_PROVIDER`, `LLM_MODEL`, `POSTGRES_*` / `DATABASE_URL`, `QDRANT_URL` /
`QDRANT_PATH`, `DATA_DIR`.

---

## 9. Phase 1 results _(measured)_

**Docling on this laptop** ("Attention Is All You Need", 15 pages, OCR off):

| | Model start-up | Conversion | Peak memory |
| --- | --- | --- | --- |
| With table structure (FAST) | 11 s warm (128 s on first run, which downloads ~0.5 GB of models) | 43 s (2.9 s/page) | 1.66 GB |
| Without tables | 9.5 s | 35 s (2.3 s/page) | 1.48 GB |

Tables stay on: they cost about 25% more time, and tables in research papers carry answers. A full
ingestion through the API took 78–115 s, depending on what else the machine was doing: parse 60–97 s, chunk
1 s, local embeddings for 44 passages ~14 s, indexing < 1 s. Docling reports no per-page progress, so the
parsing bar is an elapsed-time estimate (12 s + 3.5 s/page, capped at 95%).

**Structure:** Docling labels every PDF heading as level 1. The rebuilt tree for the paper is correct
(`3 Model Architecture › 3.2 Attention › 3.2.2 Multi-Head Attention`), and page ranges roll up to parents.
Known imperfections: figure text that Docling mistakes for headings (e.g. "Input-Input Layer5" in the
appendix) becomes a minor nested section. 44 chunks, 17–512 tokens (average ≈ 290), each with page range
and source rectangles.

**Retrieval spot check** (local `bge-small-en-v1.5`, hybrid RRF, top 3): the section holding the answer was
returned for all six probe questions (heads in the base model, optimizer and schedule, why self-attention,
WMT14 BLEU, label smoothing, positional encoding). It ranked first in five. Phase 2 makes this a
measured eval set.

**Verified behaviour** (`npm run test:ai`: 22 fast tests + 1 slow real-Docling test):
- upload → queued → parsing → chunking → embedding → indexing → ready, streamed live over SSE through the Vite proxy
- de-duplication by content hash (re-upload from another device does no work), hash and magic-byte checks
- damaged PDF and password-protected PDF are reported before the expensive parse
- permanent failure → `failed` with a readable message; manual retry; forced rebuild
- transient embedding failures retried automatically with backoff (parse cache reused); give up after the limit
- killing the backend mid-parse leaves no orphaned process; on restart the job is re-queued and completes
- dense / BM25 / hybrid search; section-scoped (including subsections) and page-range-scoped retrieval
- delete removes the file, parse cache, rows and vectors; `/health` never exposes keys

**Deviations from the proposal, pending your confirmation:** embedded Qdrant instead of a server (reasons
in §2); a `QDRANT_URL` change away. PostgreSQL now runs in Docker as proposed.

---

## 10. Phase 2 results _(measured)_

**Eval set:** `backend/eval/attention.json`, 34 questions on "Attention Is All You Need" (21 paraphrased,
13 reusing the paper's terms or numbers). A hit is relevant when its text contains an evidence phrase, so the
set survives re-chunking. The runner first checks that every phrase exists in some indexed passage. Run it
with the backend up: `backend/.venv/Scripts/python backend/eval/run.py`. Results are saved under
`backend/eval/results/`.

Local `bge-small-en-v1.5` embeddings, k = 8:

| config | hit@1 | hit@3 | hit@5 | hit@8 | MRR@8 | paraphrase hit@3 | lexical hit@3 | median latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dense | 0.765 | 0.853 | 0.882 | 0.882 | 0.801 | 0.810 | 0.923 | 34 ms |
| BM25 | 0.706 | 0.912 | 0.941 | **1.000** | 0.815 | 0.905 | 0.923 | 21 ms |
| **hybrid (RRF), default** | 0.824 | **0.941** | **1.000** | **1.000** | 0.892 | **1.000** | 0.846 | 38 ms |
| hybrid + rerank (12 candidates) | **0.853** | **0.941** | 0.971 | **1.000** | **0.904** | 0.905 | **1.000** | 1752 ms |

* **Hybrid is clearly worth it.** Dense alone misses 4 questions entirely: decoding settings, checkpoint
  averaging, future work, and who proposed scaled attention. BM25 alone finds everything by rank 8 but ranks
  answers lower. Fused, every answer is in the top 5.
* **Reranking isn't worth it on this hardware, so it is off by default.** It ranks one more question first
  and helps exact-number questions, but it pushes two paraphrased ones down: decoder masking 2 → 4, beam
  settings → 6. That costs ~1.7 s per query. Rescoring 8, 12, 20 or 30 candidates gave the same quality
  (hit@1 0.853), so when it is requested it uses 12. A comparison that added two Jina rerankers
  (`jina-reranker-v1-tiny-en`, `-turbo-en`) didn't finish within 10 minutes and was stopped. They read
  much longer inputs than MiniLM's 512 tokens, so they have no measured numbers here.
* Phase 3 sends the top 8 hybrid passages: every answer is in them.

**Selection lookup:** pdf.js selection text and Docling text are compared after reducing both to lowercase
letters and digits (NFKC), so line-break hyphens, ligatures and spacing don't matter. The order is: exact
match, then the passage holding the longest piece of the selection's start or end (a selection across two
passages), then ≥ 60% of the words in common. Passages on the selection's page are tried first. Live check: a
hyphen-wrapped sentence from p. 4 matched §3.2.1 exactly. Its top related passage was §3.2.2, which holds the
footnote explaining why dot products grow large.

**Verified behaviour** (`npm run test:ai`: 34 fast tests + 1 slow real-Docling test): reranking only on
request; hits ordered by rerank score, with more candidates than returned; a reranker that fails to load
degrades to plain hybrid and isn't reloaded on every request; context keeps reading order, merges adjacent
passages of one section (not across sections or gaps), respects the budget and still keeps the top passage;
selection lookup by exact, start and end match; `related` excludes the selection's own passage;
the retrieval endpoints return 409 until the document is ready.

---

## 11. Phase 3 results

**Built:** `folio_ai/llm/` (interface + Claude provider), `folio_ai/chat/` (prompts, turns, citation
resolution, suggestions), conversation routes, citation blocks at ingestion (pipeline v3, Alembic migration
`citation blocks and message status`). Selection modes are in the backend now (the toolbar UI is phase 5):

| Mode | Context sent | History |
| --- | --- | --- |
| `chat` | 8 hybrid passages for the (rewritten) question, in the requested scope | last 6 pairs |
| `ask` | the selection's passage first, then 8 passages from its section (unless a scope is given) | last 6 pairs |
| `explain` / `summarize` / `simplify` | the selection's passage and its neighbours in the same section, no search | none |

A selection that can't be matched to a passage (e.g. text inside a figure) is sent as a source of its own on
its page.

**Verified offline** (`npm run test:ai`: 61 fast tests + 1 slow):
- a turn streams `start → sources → status → delta… → citation → done`, and citations resolve to the right
  source, chunk, page, rectangles, quote and answer span
- invented sources or blocks are dropped and counted
- follow-ups are rewritten for search, and the model sees the earlier pairs
- explain uses the selection and its neighbours without searching; ask searches the selection's section
- refusal discards the partial answer; a provider error mid-answer keeps the partial (`error`) and leaves it
  out of later history; closing the stream stores `interrupted`
- without credentials the routes return 503 and `/health` says `configured: false`
- request validation; conversations list, get, delete, and cascade on document delete; suggestions are
  generated once
- **the Claude provider against a local stand-in for the Messages API**, using the real SDK: the exact request
  (document blocks with citations, `fallbacks: "default"` + beta header, effort, no `thinking`/`temperature`)
  and the parsing of thinking, text and `citations_delta` stream events; API errors become reader-facing
  messages (401, 404, 429, 529, and a 400 passes on the API's own explanation)
- citation blocks follow each item's page and box, including a passage that crosses a page break

**Live check: not done.** `backend/.env` now has both keys, but neither account has credit: Anthropic answers
`400 "Your credit balance is too low"` and OpenAI answers `429 insufficient_quota`. Both are now reported as
such: before, the OpenAI case was retried as a rate limit, and the Anthropic 400 was mislabelled as "too long".
`EMBEDDING_PROVIDER` was set to `local` so ingestion keeps working. The smoke script
`backend/eval/smoke_chat.py` (question, follow-up, out-of-scope question, explain) is ready to run once there is credit.

**Retrieval is unchanged** by the new chunking: hybrid hit@8 1.000, MRR 0.892, as in §10.

---

## 12. Phase 4 results

**Built:** the **Ask** tab in the reader's right sidebar (`src/features/reader/AskTab.tsx`), the client
(`src/ai/api.ts`, `src/ai/store.ts`), the answer renderer (`src/ai/answer.tsx`) and citation flashes on the
page (`PageView`). `src/ai/contracts.ts`, the unimplemented browser-side design from before the backend
existed, was removed.

| State | What the tab shows |
| --- | --- |
| backend unreachable | "Assistant offline", how to start it, *Try again*; nothing else in the reader changes |
| document never prepared | what preparing does, and *Prepare for questions* (uploads the bytes from IndexedDB) |
| preparing | the live stage and progress (SSE), retry attempt; reading continues meanwhile |
| failed | the backend's reason and *Try again* |
| ready | the conversation picker, messages, suggested questions on an empty chat, the question box |
| no `ANTHROPIC_API_KEY` | how to add it, instead of the question box |
| EPUB | "Not available for EPUB yet" (phase 7) |

* **Answers** stream in with a caret; *Stop* aborts the request (the backend stores the partial answer as
  `interrupted`). Errors show the backend's message and *Ask again*; refusals say so.
* **Citations** are `p. N` chips placed where each cited span of the answer ends (pulled back over trailing
  whitespace), with the quote as the tooltip, plus a *Sources* list per answer. Clicking one goes to the page
  at the paragraph's height and flashes the passage for four seconds. The quote is matched in the page's
  text layer for line-exact boxes, falling back to its first 80 characters and then to the stored paragraph
  box. The flash honours reduced motion.
* **Rendering** supports a small Markdown subset (paragraphs, lists, headings, bold, italics, code), built as
  React elements. Model output is never inserted as HTML, and links show as text.
* **Scope:** *Only this section* limits the search to the pages of the outline section around the current
  page (sent as `page_start`/`page_end`).
* **Conversations** live in the backend, so they're shared across devices (e.g. the tablet) and restored on
  reload. The latest one opens by default; *New conversation* starts empty, and conversations can be deleted.

**Tests:** `src/ai/answer.test.ts` (chip placement, duplicates, lists, headings, out-of-range offsets, and an
SSE parser fed in 7-byte pieces) and `tests/e2e/ask.spec.ts`, 8 Playwright tests against **the real backend**
with a scripted model. The e2e backend (`node scripts/ai.mjs e2e`, started by Playwright) runs on port 8766
with its own database `folio_ai_e2e` and data folder, both wiped at start, and uses real Docling, chunking,
local embeddings and retrieval. Covered:
- prepare → live progress → ready → suggested question → streamed, cited answer → click a citation: the page
  changes and line-sized boxes flash, then fade
- follow-ups and restoring the conversation after a reload; a new conversation
- *Stop*: the partial answer is kept and stored as interrupted
- a refusal; *Only this section* sends the section's pages, and every citation falls inside them
- offline → *Try again*; no API key; a failed preparation with its reason; EPUB

The full e2e suite passes (44 tests, about 6 minutes; the first Ask test includes a ~70 s Docling parse).

---

## 13. Gemini as a free answer model

`LLM_PROVIDER=gemini` with a free key from Google AI Studio (`GEMINI_API_KEY`) uses `folio_ai/llm/gemini.py`.
The Claude provider is unchanged and still selected with `LLM_PROVIDER=anthropic`.

* **Model:** `gemini-3.5-flash-lite` (stable). Reported free-tier quotas are far larger for Flash-Lite (about
  500 requests a day) than for 3.8 Flash (about 20 a day). Quotas are per project and change; the AI Studio
  rate-limit page shows the real ones. A chat turn uses one request, and a follow-up two (the rewrite).
  `GEMINI_MODEL` changes the model.
* **Citations:** each source sentence is sent as `[2.3] …` inside `<source>` tags, and the system prompt gets
  citation rules. `CitationMarkers` parses labels as they stream, including ones split across chunks; it
  handles ranges (`[2.3-5]`) and lists (`[2.3][4.1]`, `[1.2, 3.4]`). It removes the labels from the text and
  emits Citation + SpanEnd, so chat, citation checking and the UI are shared with Claude. Bracketed text that
  isn't a label (`[38]`, `[see Fig. 2]`) stays. Quotes come from the stored sentences, so they're verbatim.
* **Declines:** finish reasons SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII, MODEL_ARMOR and a
  blocked prompt count as a refusal, so the partial answer is discarded.
* **Errors:** 429 says the free-tier limit was reached (minute or day) and is retryable; a rejected key, an
  unknown model and 5xx get their own messages.
* **Effort** is a Claude setting and isn't sent; Gemini uses its default thinking. Measured once on the free
  tier, the default gave a first token after 1.7 s; LOW took 11.6 s and MINIMAL 25.7 s, with no thinking
  tokens reported, so the spread looks like free-tier queueing rather than thinking.
* **Privacy:** on Google's free tier, prompts and answers may be used to improve Google's products. Passages
  of the documents you ask about are sent with each question.

**Verified:** 13 tests (`tests/test_gemini_provider.py`): label parsing (split chunks, ranges, lists,
non-labels, whitespace), source formatting and escaping, and the provider through the real google-genai SDK
against a local stand-in for `streamGenerateContent`: the request (system instruction with citation rules,
roles, labelled sources), stream parsing, usage, SAFETY → refusal, 429/400/404/503 mapping, plain and
structured completions.

**Live check** (free key, the bench paper, `backend/eval/smoke_chat.py`):
- suggestions: four specific questions in 3.7 s
- "Why do they scale the dot products?": correct, with two citations resolving to the exact sentences on p. 4
- an out-of-scope question (GPT-4 hardware): "The provided passages do not contain information about…"
- explain a selection: six citations, all on p. 4
- the follow-up "And how many heads does the base model use for it?" was rewritten well ("How many attention
  heads does the base Transformer model use?"). However, §3.2.2 (h = 8) wasn't in the top 8 passages, with or
  without the reranker, so the model said the passages don't state it. That's a retrieval weakness, not a
  Gemini one: the eval's phrasing, "How many attention heads does the model use?", finds it at rank 4.
- time to first token: 2 s for explain and 9–16 s for chat turns, varying with free-tier load
- Flash-Lite sometimes writes LaTeX (`$d_k$`); the answer renderer shows inline math as italic text, with
  common commands converted (`\sqrt{d_k}` → `√d_k`)

---

## 14. Phase 5 results

**Built:** `src/features/reader/SelectionAssistant.tsx` (the card), an **Ask AI** button in the selection
toolbar (`Popovers.tsx`), `aiCard` in the reader store, `getRelated` in the client, and an option on
`askQuestion` to use a given or a fresh conversation. The backend needed no change: the modes and the
`related` endpoint were built in phases 2–3.

* **The button** shows for PDFs when the backend answered the health check, which now runs once when a PDF
  is opened. With the backend down the toolbar is exactly as before.
* **The card** opens below the selection (30 px lower on touch screens, clear of the OS selection menu,
  like the toolbar), quotes the selection, and offers Explain, Summarize, Simplify and Related, plus a question
  field (*Ask…*). It is at most 380 px wide and 70% of the screen high, scrolls inside, and repositions as an
  answer grows (`Floating` now watches its own size).
* **Answers** stream into the card with the same citation chips as the chat; a chip goes to the page and
  flashes the passage, and the card stays open. *Back* returns to the menu to try another mode.
* **Conversations:** a card's first answer creates a conversation of its own (titled e.g. "Explain this
  passage: …"); later modes in the same card go into it. It doesn't replace the Ask tab's open conversation.
  *Continue in chat* opens it in the Ask tab, where a follow-up has the explanation as its previous turn.
  Closing the card while an answer is being written stops it (stored as `interrupted`). Card conversations
  stay listed in the Ask tab; nothing is deleted.
* **Find related** calls `related` (retrieval only, no model): five passages with page, heading and a
  two-line snippet, the selection's own passage left out. Clicking one goes there and flashes its paragraphs.
* **Not ready:** an unprepared document is offered for preparation in the card, which then shows live
  progress and switches to the menu when ready. A failed preparation shows its reason with *Try again*.
  Without an LLM key the answer modes are disabled with how to add the key; Related still works. Only one
  answer streams at a time: starting a second one says to wait.

**Tests:** `tests/e2e/selection-ai.spec.ts`, 5 Playwright tests against the hermetic backend:
- select a line → *Ask AI* → Explain: the request carries the mode, text and page; the answer streams with a
  citation; the chip navigates and flashes while the card stays; *Continue in chat* shows the selection and
  answer in the Ask tab with the conversation's title; a chat follow-up sees it as the previous turn; one
  conversation in total
- *Ask…* with a typed question; *Back* → Simplify in the same card; Related: as many rows as the API
  returned, the selection's own passage excluded, a hit navigates and flashes, and no model request is made
- *Escape* during an answer closes the card and the backend stores the answer as `interrupted`
- backend offline → no *Ask AI* button; document never uploaded → the card offers *Prepare this document*
- **tablet** (800×1280, touch): a long-press-style selection, tap *Ask AI*: the card opens below the
  selection, inside the screen; tap Explain → a complete answer; tapping the page closes the card

The full e2e suite passes (49 tests, about 8 minutes).

---

## 15. Phase 6 results

**Built:** `src/ai/notes.ts` (formatting and the three saves, through `addHighlight`, `addNote` and
`saveJournal`) and a **Save** button (`src/features/reader/SaveAnswer.tsx`) on finished answers, in the
selection card and under each chat answer. Saving is local to the browser, like all reading data; the backend
is not involved.

| Save as | Where it goes | Offered in |
| --- | --- | --- |
| **Highlight + note** | a yellow highlight of the selection (one per page it spans) with the answer as the first one's note | the selection card |
| **Page note** | a note on the first page the answer cites (else the selection's page, else the current page) | card and chat |
| **Journal** | a journal entry for today, linked to the book and page; *Summarize* answers are filed as Summary, others as Thoughts | card and chat |

* **Text:** citations become page references where their chips were (`… opens. (p. 2)`; several pages at one
  point merge as `(p. 3, p. 5)`). Notes are plain text, so Markdown emphasis, heading marks and link targets are
  dropped and inline math is written as text; list lines stay. Page notes and journal entries get a title:
  the question, or "Explanation / Summary / In plain words: “selection…”", and selection answers quote the
  selection above the answer.
* **Feedback:** a confirmation names where it went ("Saved as a page note · Page 2") with *Undo*, which deletes
  what was just created. Each kind can be saved once per answer; the button then shows *Saved*.
* Saved items are ordinary highlights, page notes and journal entries: they appear in the notebook, My
  Insights (and its Markdown export) and the Journal, and can be edited or deleted there.
* The chat offers no highlight: it has the selection's text and page but not its position on the page.

**Tests:** `src/ai/notes.test.ts` (4: page references at chip positions with merging, plain-text cleanup that
leaves prices alone, titles and pages for selection and chat answers) and `tests/e2e/save-notes.spec.ts` (2
Playwright tests):
- card → Explain → save as highlight + note, page note and journal: the highlight is drawn on the page and its
  note carries the answer with "(p. N)"; the page note's exact text; both appear in My Insights; the journal
  entry is titled and linked to the book
- chat answer → no highlight option; save to journal, then a page note and *Undo*: the note is gone, the
  journal entry stays and its body has the page references

The full e2e suite passes (51 tests, about 7 minutes).

---

## 16. Faster preparation and auto-prepare

**Auto-prepare:** a PDF added to the library is sent to the backend straight away (`autoPrepare` in
`src/ai/store.ts`, called after an upload and when a reader opens a PDF the backend has never seen). It does
nothing when the backend isn't running, when the backend already knows the file (prepared, preparing or
failed: failures are retried by hand), or when *Prepare PDFs for questions automatically* is off in the
reader's Preferences (on by default). The Ask tab still offers *Prepare* for anything that slipped through.
The e2e suite turns it off by default (`playwright.config.ts` storage state) so other tests don't start
Docling parses; `tests/e2e/auto-prepare.spec.ts` covers upload, open and the preference.

**Measured** _(this laptop; the Attention paper, 15 pages; one run each, the machine was in use)_:

| Docling setting | Import + model load | Conversion |
| --- | --- | --- |
| **current**: 4 threads, FAST tables, default batches | 7 s + 10 s | 45 s (3 s/page) |
| 8 threads | 8 s + 15 s | 89 s (oversubscribes the 4 cores) |
| layout/table batches of 8 | 17 s + 23 s | 62 s |
| pypdfium text backend | 22 s + 25 s | 103 s |
| no table structure | 10 s + 12 s | 41 s (and tables lose their structure) |

The defaults are the fastest available; what can be saved is the ~17 s of start-up per document, and the
embedding padding.

**Changes:**
* **The Docling process stays loaded** for `PARSE_KEEP_WARM_S` (300 s) after a document, so uploads in a row
  load the models once (`folio_ai/ingestion/parsing.py`). It exits afterwards, returning ~1–1.5 GB to the OS;
  `0` restores a fresh process per document. A failed, cancelled or stalled child is never reused.
* **Real progress:** Docling reports each finished page; the status reads "Reading page 37 of 366 · about
  12 min left" (time left from the pace since the first page), instead of an estimate from elapsed time.
* **No 30-minute limit:** a parse is stopped when no page finishes for `PARSE_STALL_S` (600 s), or after
  `PARSE_TIMEOUT_S` (4 h). A 366-page book took 21 minutes (3.4 s/page) and would have hit the old limit on
  a slower day.
* **Embedding in length order:** a batch is padded to its longest passage, so passages are embedded sorted by
  length and the vectors put back in order. One measurement on the paper (44 passages, machine busy): 21 s →
  13 s.

Through the API, the paper is ready in **66 s** after another document (phase 1: 78–115 s): parsing 50 s,
embedding 14 s (before the length ordering), indexing < 1 s.

**Tests:** `tests/test_parsing.py` (7: the process is reused between documents and exits when idle, a fresh
one per document with keep-warm 0, page progress is relayed, a stalled parse is stopped and the process
replaced, a failed document reports its reason, cancel, time-left wording), a retrieval test that every
stored vector belongs to its passage after length ordering, the slow real-Docling test, and 3 Playwright
tests for auto-prepare. Full suites: 83 backend tests, 54 Playwright tests.

## 17. Lighter layout model

**Where the time goes** (the Attention paper, 15 pages, Docling's per-stage timings; layout and table
structure run concurrently):

| Stage | Time |
| --- | --- |
| Layout detection (`layout_heron_default`) | 36.6 s |
| Table structure (FAST) | 22.6 s, overlapping layout |
| Page parse, assembly, reading order | ~1 s |
| Chunking | 0.6 s |
| Local embeddings (44 passages, bge-small) | 12 s, CPU-bound at either batch size (16 or 64) |
| BM25 + indexing | < 1 s |

**Change:** `PARSE_LAYOUT_MODEL` (default `layout_egret_medium`) picks the Docling layout preset
(`LayoutObjectDetectionOptions.from_preset`). `layout_heron_default` restores Docling's default.

**Measured** _(this laptop, machine in use, so the absolute times vary by up to 50% between runs)_:

| | `layout_heron_default` | `layout_egret_medium` |
| --- | --- | --- |
| Conversion, standalone | 40.0 s (layout 36.6 s) | 30.3 s (layout 22.8 s) |
| Through the API, cold reader (two runs) | parse 101 s / 106 s, ready 120 s / 124 s | parse 86 s / 99 s, ready 104 s / 117 s |
| Structure | 28 headings, 4 tables, 44 chunks | 26 headings, 5 tables, 43 chunks |

Once layout is lighter, table structure (~22 s) is the longest stage on table-heavy pages.

**Retrieval eval** (`eval/attention.json`, 34 questions, k = 8; evidence found in the passages for every
question with both models):

| | heron hit@1 / hit@3 / MRR | egret-medium hit@1 / hit@3 / MRR |
| --- | --- | --- |
| dense | 0.765 / 0.853 / 0.801 | 0.794 / 0.853 / 0.821 |
| bm25 | 0.706 / 0.912 / 0.815 | 0.735 / 0.912 / 0.830 |
| hybrid | 0.824 / 0.941 / 0.892 | 0.853 / 0.971 / 0.914 |
| hybrid + rerank | 0.853 / 0.941 / 0.904 | 0.853 / 0.941 / 0.904 |

The parse cache (`parse_version`) is unchanged: documents already parsed keep their Heron parse and are not
re-read. Full backend suite: 84 tests, including the slow real-Docling test with the new model.

## 18. Quick pass: answers in seconds, then the full reading

Docling needs 2–4 s a page here, so a paper took over a minute and a long book 20 minutes before the first
question could be asked. Now every new document gets two passes:

1. **Quick pass** (`folio_ai/ingestion/quick.py`, its own worker thread): pdfium reads the text layer
   (0.8 s for the paper). Its line pieces are grouped into paragraphs (same line → joined; a small vertical gap
   with horizontal overlap → same paragraph), with each paragraph's box normalised to the page like Docling's.
   Passages are cut to the same token budget with the embedding model's tokenizer and get the same citation
   blocks, so cited answers and the citation flash work as before. Chunk ids are `{doc}:q{n}`. The document
   turns **ready** with `index: "quick"`, `refining: true`. It also starts loading Docling
   (`DoclingParser.warm()`), so the reader's ~30 s start-up overlaps this pass.
2. **Full pass** (the existing Docling pipeline, on the other worker; a document's full job waits until its
   quick job is over). While it runs, the document stays ready and its `detail` shows the progress. At the
   end, the passages (PostgreSQL) and vectors (Qdrant) are replaced together under the services lock, so a
   question asked meanwhile sees the old passages or the new ones, not a mix. Then `index: "full"`.

Edge cases: a PDF without a text layer skips the quick pass, and the full pass reports it as before. A
document whose Docling parse is cached skips it too, since the full pass is quick then. A failed quick pass never
fails the document; the full pass still runs. A failed full pass after a quick one leaves the document
ready on its quick passages, with `error` set; the Ask tab says so and offers *Try again* (retry is allowed
for such a document without `force`). A document can't be deleted while one of its jobs is running. The SSE
stream stays open while a document is refining. `QUICK_INDEX=false` restores a single pass.

**Measured** (the Attention paper, through the API, models on disk, machine in use; two runs each):

| | Answerable | Fully ready |
| --- | --- | --- |
| One pass (`QUICK_INDEX=false`) | 76 s / 90 s | 76 s / 90 s |
| Quick pass, then full | **12 s / 11 s** | 92 s / 81 s |

The quick pass is mostly embedding (24 passages, ~9 s). The extra time to full readiness (the quick pass's own
embedding) is within the run-to-run noise once Docling warms up during it.

**Interim answer quality** (`eval/attention.json`, 34 questions, k = 8). Evidence was found in the quick passages for
31 of 34 questions. The three misses are inline math that pdfium renders differently from Docling
("df f", "warmup _steps", "PdPdrop"):

| | quick hit@1 / hit@3 / MRR | full (§17) hit@1 / hit@3 / MRR |
| --- | --- | --- |
| dense | 0.618 / 0.735 / 0.695 | 0.794 / 0.853 / 0.821 |
| bm25 | 0.529 / 0.765 / 0.662 | 0.735 / 0.912 / 0.830 |
| hybrid | 0.647 / 0.882 / 0.757 | 0.853 / 0.971 / 0.914 |
| hybrid + rerank | 0.647 / 0.824 / 0.749 | 0.853 / 0.941 / 0.904 |

Two text fixes mattered: pieces that touch on the same line join without a space (subscripts and font
changes: "d k" → "dk"), and pdfium's line-break hyphen mark (`\x02`) and spaced-out decimals ("0 . 1") are
repaired. Before them, 6 questions' evidence was missing and hybrid hit@3 was 0.765.

**Tests:** `tests/test_quick.py` (6: passages keep pages, rectangles and citation blocks; a document answers
from the quick pass and switches to the full one; the SSE stream follows a refining document; a failed full
pass keeps the quick passages and can be retried; a PDF without text skips the quick pass; a running
preparation can't be deleted), a parsing test for `warm()`, and the main Playwright Ask test now checks that
the chat opens before the full pass and that the *refining* note goes away after it.
