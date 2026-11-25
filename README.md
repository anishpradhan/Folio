# Folio

A quiet, local-first reading room for PDFs. Upload documents to a personal library and read them in an immersive
viewer. Highlight, annotate, bookmark and look up words as you go, then revisit everything in one place. No account
or server is needed: documents and annotations live in your browser's IndexedDB.

```bash
npm install          # also copies pdf.js cmaps/fonts into public/pdfjs
npm run dev          # http://localhost:5173
npm run build        # typecheck + production build into dist/
npm test             # unit tests (vitest)
npm run fixtures     # regenerate test PDFs in tests/fixtures
npx playwright install chromium   # once
npm run test:e2e     # end-to-end tests against the real app (starts Vite on :5179)
```

## What's inside

| Area | Highlights |
| --- | --- |
| **Library** | Drag-and-drop anywhere or use the file picker. Covers are rendered from page 1. *Continue reading* and *Recently added* shelves. Search by title, author, filename, subject and keywords. Sort by opened, added, title or progress. Favorites, custom collections, progress and last-read times, editable details. Duplicate detection (SHA-256). Removing a book can be undone. Clear errors for unsupported, encrypted, empty and damaged files. |
| **Reader** | PDF.js rendering at device resolution with a selectable text layer. Continuous scroll is virtualised: only visible pages are in the DOM, verified with a 400-page document. Single-page and two-page spread (book-style) layouts. Zoom steps, Ctrl/⌘+wheel and pinch zoom, fit to width and fit to page. Page input (accepts page labels), draggable progress scrubber with bookmark ticks, first/previous/next/last. Distraction-free mode, full screen, and a page-turn animation. |
| **Navigation** | Table of contents from the PDF outline, nested and collapsible, with the current section tracked. Documents without an outline show their real metadata and a page list (first line of each page); no chapters are invented. Lazy page thumbnails. In-document search with match count, snippets grouped by page, highlighted matches on the page, next/previous with Enter / Shift+Enter, and an exact scroll to each match. |
| **Annotations** | A floating toolbar on any selection: highlight in five colours, add a note, bookmark the page, look up the word, copy. Highlights are stored as page-normalised rectangles (zoom-independent) together with their text. Clicking one opens a card to edit its note, change its colour, mark it important or delete it (with undo). Bookmarks have titles and notes. Page notes are timestamped and editable. Everything persists. |
| **Dictionary** | A real lookup via the [Free Dictionary API](https://dictionaryapi.dev) (Wiktionary data, no key): pronunciation and audio, part of speech, definitions, examples and synonyms (click one to look it up). Simple inflection fallback (*running → run*). Offline, error and not-found states. Words save to the vocabulary notebook along with the sentence they came from. |
| **My Insights** | Highlights, bookmarks, notes and important passages from every book in one place. Search, filter by kind, document and colour, sort or group by book, jump to the exact spot (the highlight flashes on arrival), and export to Markdown. |
| **Vocabulary** | Saved words with definitions and source context. Mark them learned, review them flashcard-style, and jump back to the page where each was found. |
| **Journal** | Entries typed as thoughts, chapter summaries, takeaways or reflections, linked to a book, page and date. Autosaves. |
| **Reading Life** | Totals, streaks, a 16-week reading calendar and minutes per day. Goals for pages per day, minutes per day, or finishing a book by a date, with an honest pages-per-day projection. Recently completed books. Time only counts while you are actively reading. |
| **Personalisation** | Four app themes: Warm Editorial, Midnight Library, Nordic Minimal, Vintage Paper. Page presets: Original, Paper, Warm, Sepia, Dark, Midnight. Background colour, paper textures, warmth, brightness, contrast, sepia, page shadow, spacing and reading width. These are viewing filters only; the PDF is never modified. **Text view** re-flows the extracted text and applies the typography settings (font, size, line height, letter and paragraph spacing, alignment, line length). Remappable keyboard shortcuts and an optional reading timer. All preferences persist. |
| **Resume** | Reopening a document restores the page, the scroll offset within it, zoom mode and scale, layout, and text or original view. |

### Keyboard (defaults, remappable under Reading room → Reading)

`←/→` page · `Home/End` first/last · `=`/`-` zoom · `W` fit width · `P` fit page · `Ctrl+F` search · `[` contents ·
`]` notebook · `B` bookmark · `F` distraction-free · `Shift+F` full screen · `D` dark pages · `L` cycle layout ·
`T` text view · `,` preferences · `Esc` closes things. In paged layouts, `Space` / `PageDown` turn the page.

## AI document Q&A (in progress)

An optional Python backend (`backend/`) prepares PDFs for grounded question answering. It handles parsing (Docling), structure-aware
chunking, embeddings and hybrid search (Qdrant). Phases 1–4 are done: ingestion, retrieval, cited answers, and the **Ask** tab in the reader (Notebook → Ask) with streaming answers whose citations jump to the quoted passage. The selection assistant comes next. Design and plan:
[docs/ai/architecture.md](docs/ai/architecture.md). Setup: [backend/README.md](backend/README.md). The reader works unchanged without it.

## Run everything with Docker

`docker-compose.yml` runs the whole app in three containers: the reader (`web`), the AI backend
(`backend`: FastAPI, Docling, local embeddings, embedded Qdrant) and PostgreSQL.

```bash
cp .env.example .env          # set POSTGRES_PASSWORD, and GEMINI_API_KEY or ANTHROPIC_API_KEY for answers
docker compose up -d --build  # first build downloads ~2 GB (CPU-only PyTorch, Docling, Node packages)
# open http://localhost:8080
```

- **Memory:** give Docker at least 4 GB. The backend uses about 1 GB idle and 2.5–3 GB while Docling reads a
  PDF. Without enough memory, run only the reader with `docker compose up -d web`; the Ask tab then shows the
  assistant as offline.
- **Data** lives in named volumes: `folio_data` (uploaded PDFs, parses, vector index), `folio_models` (about 1 GB of
  models, downloaded when the first document is prepared) and `folio_pg` (the database). `docker compose down`
  keeps them; `docker compose down -v` deletes them. Your library, highlights and notes stay in the browser
  (IndexedDB), as without Docker.
- **Network:** only the reader's port is published, on localhost. The backend and database are reachable only
  inside the compose network, and the browser reaches the backend through the reader's `/api/ai` proxy.
- **Image sizes:** `folio-web` is about 0.8 GB (it runs `vite preview`, which also serves `/api/fetch` for
  importing documents from a link). `folio-backend` is several GB, mostly PyTorch and Docling.
- **Development** without containers is unchanged: `npm run ai:db` starts only PostgreSQL
  (`backend/docker-compose.yml`), and `npm run dev` / `npm run ai` run the app and backend on the host.

## Architecture

```
src/
  core/            Document processing: no UI, no persistence decisions
    types.ts         Domain model (DocumentRecord, PageTextRecord, Highlight, …)
    formats.ts       Format registry + magic-byte sniffing (PDF supported; EPUB registered, not yet)
    pdf/             pdf.js setup, ingestion (metadata, outline, page sizes, cover), background
                     full-text indexing, text-content cache
    text/            Page-text structuring (lines/paragraphs), search folding & matching
    geometry.ts      Selection → normalised highlight rects
    dictionary.ts    DictionaryProvider interface + Free Dictionary API provider
  data/            IndexedDB schema (idb), repositories, live queries (+ cross-tab sync)
  state/           Persisted preferences, upload queue (zustand)
  features/        library · reader · insights · vocabulary · journal · stats · shell
  ai/contracts.ts  Interfaces for the future RAG pipeline (not implemented, not imported)
```

- **Storage.** IndexedDB holds the documents (with original bytes), extracted page text, highlights, bookmarks,
  notes, vocabulary, journal, collections, daily activity and goals. Updates are read-modify-write inside a single
  transaction, so concurrent edits never overwrite each other. Preferences live in `localStorage`, with an in-memory
  fallback.
- **Live data.** `useLive(query, stores)` re-runs a query whenever a write touches those stores, including writes from
  other tabs via `BroadcastChannel`. IndexedDB is the single source of truth, not React state.
- **Text pipeline.** On upload, page text is extracted in the background with line and paragraph structure, plus the
  outline section of each page. Search, text view and (later) chunking for Q&A all use this one source.
- **Locations.** Everything addresses `(docId, page)`, plus normalised rects for highlights. A future AI answer's
  citations can therefore deep-link (`#/read/:id?page=…&hl=…`) exactly as Insights does today.

### Future: document Q&A (designed, not built)

`src/ai/contracts.ts` defines `Chunker`, `EmbeddingProvider`, `VectorStore`, `Retriever`/`AnswerGenerator` and
`Citation`. The plan:

1. Chunk the `pages` store by paragraph or section, keeping page ranges and outline paths.
2. Store embeddings in a v2 IndexedDB store (or a remote vector DB).
3. Retrieve with semantic search, mixed with the existing lexical search.
4. Answer with an LLM and cite `(docId, page)`.

The dictionary popover already passes the surrounding sentence and the page, so an *Explain in context* provider can
slot in next to the dictionary. The UI shows no AI features until they are real.

## Known limitations

- PDF only. EPUB is detected and reported as "coming soon"; the format registry and the reflow view are the seams
  for it.
- Password-protected PDFs are rejected with a clear message. Scanned PDFs without a text layer render fine, but
  search, highlighting and text view need text (no OCR yet).
- The dictionary is English-only and needs a network connection.
- Highlights made in text view are matched back to the page layout by their text; a phrase that appears twice on the
  same page resolves to its first occurrence.
