"""Ingestion stages for one document: parse → chunk → embed → index, with observable status."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Callable, Protocol

from sqlalchemy import delete

from ..config import Settings
from ..db import Chunk, Database, Document, DocumentStatus, IndexKind, Section
from ..services import Services
from ..vectorstore import ChunkPoint
from .chunking import ChunkedDocument, chunk_document
from .quick import quick_chunks

log = logging.getLogger("folio_ai.pipeline")


class IngestionError(Exception):
    """A permanent, user-facing failure (bad file, nothing to index…). Not retried automatically."""


def eta_text(seconds: float) -> str:
    """'about 40 s left' / 'about 12 min left' (rounded up; minutes from 90 s on)."""
    if seconds < 90:
        return f"about {max(10, int(-(-seconds // 10) * 10))} s left"
    return f"about {int(-(-seconds // 60))} min left"


def pdf_page_count(path: Path) -> int:
    """Page count via pdfium (fast); also the earliest place to notice a locked or broken PDF."""
    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(str(path))
    except pdfium.PdfiumError as e:
        msg = str(e).lower()
        if "password" in msg:
            raise IngestionError("This PDF is password-protected, so it can't be read.") from e
        raise IngestionError("This file isn't a readable PDF (it may be damaged).") from e
    try:
        return len(pdf)
    finally:
        pdf.close()


class Parser(Protocol):
    def parse(self, pdf_path: str, out_json: str, on_progress: Callable[[int, int], None] | None = None) -> None: ...
    def cancel(self) -> None: ...


class Pipeline:
    def __init__(self, db: Database, settings: Settings, services: Services, parser: Parser):
        self.db = db
        self.settings = settings
        self.services = services
        self.parser = parser

    def cancel(self) -> None:
        self.parser.cancel()

    # -- status --------------------------------------------------------------------------------
    def _status(self, document_id: str, status: str, progress: float = 0.0, detail: str | None = None, **fields: object) -> None:
        with self.db.session() as s:
            doc = s.get(Document, document_id)
            if doc is None:
                raise IngestionError("The document was removed while it was being prepared.")
            doc.status = status
            doc.progress = max(0.0, min(1.0, progress))
            doc.status_detail = detail
            doc.error = None
            for k, v in fields.items():
                setattr(doc, k, v)

    # -- run -----------------------------------------------------------------------------------
    def run_quick(self, document_id: str, *, on_stage: Callable[[str], None] = lambda _: None) -> bool:
        """The quick pass (text layer only), so questions work within seconds. False when it was skipped:
        the document is already searchable, its Docling parse is cached (the full pass is quick then), or the
        PDF has no text layer (the full pass reports that)."""
        st = self.settings
        pdf = st.files_dir / f"{document_id}.pdf"
        if not pdf.exists():
            raise IngestionError("The document's file is missing on the server. Prepare it again from the reader.")
        with self.db.session() as s:
            doc = s.get(Document, document_id)
            if doc is None:
                raise IngestionError("The document was removed while it was being prepared.")
            if doc.index_kind is not None:
                return False
            title = doc.title
        if (st.parsed_dir / f"{document_id}.v{st.parse_version}.json").exists():
            return False

        on_stage(DocumentStatus.PARSING)
        pages = pdf_page_count(pdf)
        warm = getattr(self.parser, "warm", None)
        if warm:
            warm()  # Docling loads its models while this pass runs; the full pass follows straight after
        self._status(document_id, DocumentStatus.PARSING, 0.0, f"Reading the text ({pages} page{'s' if pages != 1 else ''})…")
        d = quick_chunks(document_id, pdf, self.services.embedder.model, st.chunk_max_tokens, str(st.models_dir), title=title)
        if not d.chunks:
            self._status(document_id, DocumentStatus.QUEUED, 0.0, "Waiting to start")
            return False
        def report(stage: str, progress: float = 0.0, detail: str | None = None, **fields: object) -> None:
            self._status(document_id, stage, progress, detail, **fields)

        self._embed_and_index(document_id, d, IndexKind.QUICK, report, on_stage, done_detail="Waiting to read headings and tables")
        log.info("quick index %s: %d pages, %d chunks", document_id[:12], d.page_count, len(d.chunks))
        return True

    def run(self, document_id: str, *, force: bool = False, on_stage: Callable[[str], None] = lambda _: None) -> None:
        """The full pass: Docling parse → chunk → embed → index. After a quick pass the document stays ready
        (and searchable) throughout; the new passages replace the quick ones in one step at the end."""
        st = self.settings
        pdf = st.files_dir / f"{document_id}.pdf"
        if not pdf.exists():
            raise IngestionError("The document's file is missing on the server. Prepare it again from the reader.")
        with self.db.session() as s:
            doc = s.get(Document, document_id)
            refining = doc is not None and doc.status == DocumentStatus.READY and doc.index_kind == IndexKind.QUICK

        def report(stage: str, progress: float = 0.0, detail: str | None = None, **fields: object) -> None:
            self._status(document_id, DocumentStatus.READY if refining else stage, progress, detail, **fields)

        # 1. Parsing (slow; cached per file + pipeline version so retries after later failures skip it)
        parsed = st.parsed_dir / f"{document_id}.v{st.parse_version}.json"
        if force or not parsed.exists():
            on_stage(DocumentStatus.PARSING)
            pages = pdf_page_count(pdf)
            report(DocumentStatus.PARSING, 0.0, f"Starting the document reader ({pages} page{'s' if pages != 1 else ''})…")
            tmp = parsed.with_suffix(".tmp")
            # Docling reports each finished page. The time left is estimated from the pace since the first one
            # (that one also carries model start-up when the reader wasn't loaded yet).
            first: list[float] = []
            last_write = [0.0]

            def on_progress(done: int, total: int) -> None:
                now = time.monotonic()
                if not first:
                    first.append(now)
                    first.append(done)
                if now - last_write[0] < 1.0 and done < total:
                    return  # at most one status write a second
                last_write[0] = now
                detail = f"Reading page {done} of {total}"
                pace_pages = done - first[1]
                if pace_pages >= 2 and done < total:
                    detail += f" · {eta_text((now - first[0]) / pace_pages * (total - done))}"
                report(DocumentStatus.PARSING, done / max(1, total), detail)

            self.parser.parse(str(pdf), str(tmp), on_progress=on_progress)
            tmp.replace(parsed)

        # 2. Chunking
        on_stage(DocumentStatus.CHUNKING)
        report(DocumentStatus.CHUNKING, 0.0, "Splitting into passages…")
        doc_chunks = chunk_document(document_id, parsed, self.services.embedder.model, st.chunk_max_tokens, str(st.models_dir))
        if not doc_chunks.chunks:
            raise IngestionError("No text was found in this PDF. It may be a scanned document; text recognition (OCR) isn't enabled yet.")

        # 3-4. Embedding and indexing
        self._embed_and_index(document_id, doc_chunks, IndexKind.FULL, report, on_stage)
        log.info("ingested %s: %d pages, %d sections, %d chunks", document_id[:12], doc_chunks.page_count, len(doc_chunks.sections), len(doc_chunks.chunks))

    def _embed_and_index(
        self,
        document_id: str,
        d: ChunkedDocument,
        kind: str,
        report: Callable[..., None],
        on_stage: Callable[[str], None],
        done_detail: str | None = None,
    ) -> None:
        st = self.settings
        embedder = self.services.embedder

        # Embedding (dense + BM25 term vectors)
        on_stage(DocumentStatus.EMBEDDING)
        n = len(d.chunks)
        texts = [c.embed_text for c in d.chunks]
        # Small steps for visible progress; the OpenAI provider still sends its own larger batches.
        batch = 16 if not st.use_openai_embeddings else max(1, st.embedding_batch_size)
        # Passages of similar length go together: a batch is padded to its longest passage, so mixing short
        # and long ones wastes most of the work. The vectors are put back in passage order.
        order = sorted(range(n), key=lambda k: len(texts[k]))
        by_order: list[list[float]] = []
        for i in range(0, n, batch):
            report(DocumentStatus.EMBEDDING, i / n, f"Embedding passages {i + 1}–{min(n, i + batch)} of {n}")
            with self.services.lock:
                by_order.extend(embedder.embed_documents([texts[k] for k in order[i : i + batch]]))
        dense: list[list[float]] = [[] for _ in range(n)]
        for pos, k in enumerate(order):
            dense[k] = by_order[pos]
        with self.services.lock:
            sparse = self.services.bm25.embed_documents(texts)

        # Indexing: the passages (database) and their vectors (Qdrant) are replaced together, under the lock
        # searches take, so a question asked meanwhile sees the old passages or the new ones, not a mix.
        on_stage(DocumentStatus.INDEXING)
        report(DocumentStatus.INDEXING, 0.0, "Saving to the search index…")
        points = [
            ChunkPoint(
                chunk_id=c.id,
                dense=dense[k],
                sparse=sparse[k],
                payload={
                    "document_id": document_id,
                    "ordinal": c.ordinal,
                    "section_id": c.section_id,
                    "section_ids": c.section_ids,
                    "page_start": c.page_start,
                    "page_end": c.page_end,
                    "heading_path": c.heading_path,
                    "text": c.text,
                },
            )
            for k, c in enumerate(d.chunks)
        ]
        with self.services.lock:
            store = self.services.store
            self._save_structure(document_id, d)
            store.delete_document(document_id)
            store.upsert(points)
            stored = store.count(document_id)
        if stored != n:
            raise IngestionError(f"The search index stored {stored} of {n} passages.")

        self._status(
            document_id,
            DocumentStatus.READY,
            1.0 if kind == IndexKind.FULL else 0.0,
            done_detail,
            chunk_count=n,
            page_count=d.page_count,
            embedding_model=embedder.model,
            pipeline_version=st.pipeline_version,
            index_kind=kind,
        )

    def _save_structure(self, document_id: str, d: ChunkedDocument) -> None:
        with self.db.session() as s:
            s.execute(delete(Chunk).where(Chunk.document_id == document_id))
            s.execute(delete(Section).where(Section.document_id == document_id))
            s.add_all(
                Section(
                    id=x.id,
                    document_id=document_id,
                    parent_id=x.parent_id,
                    ordinal=x.ordinal,
                    level=x.level,
                    title=x.title,
                    page_start=x.page_start,
                    page_end=x.page_end,
                )
                for x in d.sections
            )
            s.flush()  # sections first: chunks reference them by foreign key
            s.add_all(
                Chunk(
                    id=c.id,
                    document_id=document_id,
                    ordinal=c.ordinal,
                    section_id=c.section_id,
                    heading_path=c.heading_path,
                    text=c.text,
                    embed_text=c.embed_text,
                    page_start=c.page_start,
                    page_end=c.page_end,
                    locations=c.locations,
                    token_count=c.token_count,
                    kinds=c.kinds,
                    blocks=c.blocks,
                )
                for c in d.chunks
            )
            doc = s.get(Document, document_id)
            if doc is not None:
                doc.page_count = d.page_count
                if d.title and not doc.title:
                    doc.title = d.title
