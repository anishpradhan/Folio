"""FastAPI application: document registration, ingestion status (polling + SSE), retry, inspection."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Literal

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from starlette.concurrency import run_in_threadpool

from .config import Settings, get_settings
from .chat import ChatService, Selection, TurnRequest, suggest_questions
from .db import Chunk, Conversation, Database, Document, DocumentStatus, IndexKind, IngestionJob, JobKind, JobStatus, Message, Section, migrate
from .documents import HASH_RE, UploadError, delete_document, register_upload
from .ingestion.pipeline import Parser, Pipeline
from .ingestion.worker import Worker, enqueue_document, recover
from .llm import LLMError
from .retrieval import Retriever, Scope, assemble_context, locate_selection
from .retrieval.retriever import Passage
from .services import Services

log = logging.getLogger("folio_ai")


@dataclass
class Runtime:
    settings: Settings
    db: Database
    services: Services
    worker: Worker  # full Docling passes
    quick_worker: Worker  # quick text-layer passes

    def wake(self) -> None:
        self.quick_worker.wake()
        self.worker.wake()


def iso(t: datetime | None) -> str | None:
    """ISO 8601 in UTC (naive datetimes are treated as UTC)."""
    if t is None:
        return None
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).isoformat()


def is_refining(d: Document) -> bool:
    """Answering from the quick pass while the full one runs (or waits). False once that failed."""
    return d.status == DocumentStatus.READY and d.index_kind == IndexKind.QUICK and d.error is None


def doc_json(d: Document, job: IngestionJob | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": d.id,
        "title": d.title,
        "fileName": d.file_name,
        "fileSize": d.file_size,
        "pageCount": d.page_count,
        "status": d.status,
        "progress": round(d.progress, 4),
        "detail": d.status_detail,
        "error": d.error,
        "chunkCount": d.chunk_count,
        # "quick": passages from the text layer while Docling reads the layout; "full": from Docling.
        "index": d.index_kind,
        "refining": is_refining(d),
        "embeddingModel": d.embedding_model,
        "updatedAt": iso(d.updated_at),
    }
    if job is not None:
        out["job"] = {"id": job.id, "status": job.status, "stage": job.stage, "attempt": job.attempt, "error": job.error, "errorKind": job.error_kind}
    return out


def _latest_job(db: Database, document_id: str) -> IngestionJob | None:
    with db.session() as s:
        return s.scalars(select(IngestionJob).where(IngestionJob.document_id == document_id).order_by(IngestionJob.created_at.desc())).first()


def _check_id(document_id: str) -> str:
    if not HASH_RE.match(document_id):
        raise HTTPException(400, "Document ids are SHA-256 hex digests.")
    return document_id


class ScopeFields(BaseModel):
    section_id: str | None = None
    page_start: int | None = Field(None, ge=1)
    page_end: int | None = Field(None, ge=1)

    @property
    def scope(self) -> Scope:
        return Scope(self.section_id, self.page_start, self.page_end)


class SearchRequest(ScopeFields):
    query: str = Field(min_length=1, max_length=2000)
    limit: int = Field(8, ge=1, le=50)
    mode: Literal["hybrid", "dense", "bm25"] = "hybrid"
    rerank: bool | None = None  # default: RERANK_BY_DEFAULT (off)


class RelatedRequest(ScopeFields):
    text: str = Field(min_length=1, max_length=20_000)
    page: int | None = Field(None, ge=1)  # the page the selection is on; narrows the lookup
    limit: int = Field(5, ge=1, le=20)


class ContextRequest(SearchRequest):
    budget_tokens: int | None = Field(None, ge=100, le=100_000)


class SelectionIn(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    page: int | None = Field(None, ge=1)


class MessageRequest(ScopeFields):
    content: str = Field("", max_length=4000)
    mode: Literal["chat", "explain", "summarize", "simplify", "ask"] = "chat"
    selection: SelectionIn | None = None

    @model_validator(mode="after")
    def _check(self) -> "MessageRequest":
        if self.mode in ("chat", "ask") and not self.content.strip():
            raise ValueError("A question is required.")
        if self.mode != "chat" and self.selection is None:
            raise ValueError(f"The {self.mode} mode needs the selected text.")
        return self


class ConversationCreate(BaseModel):
    title: str = Field("", max_length=200)


def conversation_json(c: Conversation, message_count: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"id": c.id, "documentId": c.document_id, "title": c.title, "createdAt": iso(c.created_at), "updatedAt": iso(c.updated_at)}
    if message_count is not None:
        out["messageCount"] = message_count
    return out


def message_json(m: Message) -> dict[str, Any]:
    return {
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "mode": m.mode,
        "scope": m.scope,
        "citations": m.citations,
        "status": m.status,
        "model": m.model,
        "retrieval": m.retrieval,
        "createdAt": iso(m.created_at),
    }


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _require_llm(rt: Runtime) -> None:
    if not rt.services.llm_configured:
        raise HTTPException(503, f"The assistant isn't configured: add {rt.settings.llm_key_name} to backend/.env and restart the backend.")


def _require_ready(rt: Runtime, document_id: str) -> None:
    _check_id(document_id)
    with rt.db.session() as s:
        doc = s.get(Document, document_id)
        if doc is None or doc.status != DocumentStatus.READY:
            raise HTTPException(409, "This document isn't ready for questions yet.")


def build_router(rt_of: Any) -> APIRouter:
    r = APIRouter(prefix="/api/ai")

    @r.get("/health")
    def health(request: Request) -> dict[str, Any]:
        rt: Runtime = rt_of(request)
        st = rt.settings
        with rt.db.session() as s:
            counts = dict(s.execute(select(Document.status, func.count()).group_by(Document.status)).all())
        return {
            "ok": True,
            "embedding": {"provider": "openai" if st.use_openai_embeddings else "local", "model": st.embedding_model},
            "reranker": {"model": st.reranker_model, "default": st.rerank_by_default},
            "llm": {
                "provider": "scripted" if st.llm_fake else st.llm_provider,
                "model": st.answer_model,
                "configured": rt.services.llm_configured,
            },
            "worker": rt.worker.is_alive(),
            "documents": counts,
            "pipelineVersion": st.pipeline_version,
        }

    @r.post("/documents")
    def upload(
        request: Request,
        file: UploadFile = File(...),
        sha256: str | None = Form(None),
        title: str = Form(""),
        file_name: str = Form(""),
    ) -> JSONResponse:
        rt: Runtime = rt_of(request)
        try:
            reg = register_upload(
                rt.db, rt.settings, file.file, claimed_hash=sha256, title=title, file_name=file_name or file.filename or "", embedding_model=rt.services.embedder.model
            )
        except UploadError as e:
            raise HTTPException(e.status, str(e)) from e
        job = None
        if reg.needs_ingestion:
            job = enqueue_document(rt.db, rt.settings, reg.document.id)
            rt.wake()
        with rt.db.session() as s:
            doc = s.get(Document, reg.document.id)
            assert doc is not None
            return JSONResponse(doc_json(doc, job or _latest_job(rt.db, doc.id)), status_code=202 if reg.needs_ingestion else 200)

    @r.get("/documents/{document_id}")
    def get_document(request: Request, document_id: str) -> dict[str, Any]:
        rt: Runtime = rt_of(request)
        _check_id(document_id)
        with rt.db.session() as s:
            doc = s.get(Document, document_id)
            if doc is None:
                raise HTTPException(404, "This document hasn't been prepared for questions yet.")
            return doc_json(doc, _latest_job(rt.db, document_id))

    @r.get("/documents/{document_id}/events")
    async def events(request: Request, document_id: str) -> StreamingResponse:
        """Server-sent events: one `status` event per change, until the document is fully ready or failed
        (a document answering from its quick pass is followed until the full pass is done)."""
        rt: Runtime = rt_of(request)
        _check_id(document_id)

        def snapshot() -> dict[str, Any] | None:
            with rt.db.session() as s:
                doc = s.get(Document, document_id)
                return doc_json(doc) if doc else None

        async def stream() -> AsyncIterator[str]:
            last: str | None = None
            idle = 0.0
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                snap = await asyncio.to_thread(snapshot)
                if snap is None:
                    yield f"event: error\ndata: {json.dumps({'error': 'not found'})}\n\n"
                    return
                body = json.dumps(snap)
                if body != last:
                    last, idle = body, 0.0
                    yield f"event: status\ndata: {body}\n\n"
                    if snap["status"] == DocumentStatus.FAILED or (snap["status"] == DocumentStatus.READY and not snap["refining"]):
                        return
                elif idle >= 15:
                    idle = 0.0
                    yield ": keep-alive\n\n"
                await asyncio.sleep(0.5)
                idle += 0.5

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    @r.post("/documents/{document_id}/retry")
    def retry(request: Request, document_id: str, force: bool = Query(False)) -> JSONResponse:
        rt: Runtime = rt_of(request)
        _check_id(document_id)
        with rt.db.session() as s:
            doc = s.get(Document, document_id)
            if doc is None:
                raise HTTPException(404, "Unknown document.")
            if doc.status in DocumentStatus.ACTIVE:
                raise HTTPException(409, "This document is already being prepared.")
            # A document answering from its quick pass can retry a failed full pass.
            if doc.status == DocumentStatus.READY and not force and doc.index_kind != IndexKind.QUICK:
                raise HTTPException(409, "This document is already ready. Use force=true to rebuild it.")
        job = enqueue_document(rt.db, rt.settings, document_id, force=force)
        rt.wake()
        with rt.db.session() as s:
            return JSONResponse(doc_json(s.get(Document, document_id), job), status_code=202)  # type: ignore[arg-type]

    @r.delete("/documents/{document_id}", status_code=204)
    def remove(request: Request, document_id: str) -> None:
        rt: Runtime = rt_of(request)
        _check_id(document_id)
        with rt.db.session() as s:
            doc = s.get(Document, document_id)
            running = s.scalar(
                select(func.count()).select_from(IngestionJob).where(IngestionJob.document_id == document_id, IngestionJob.status == JobStatus.RUNNING)
            )
            if doc is not None and running:
                raise HTTPException(409, "This document is being prepared; try again when it finishes.")
        if not delete_document(rt.db, rt.settings, document_id):
            raise HTTPException(404, "Unknown document.")
        with rt.services.lock:
            if "store" in rt.services.__dict__:
                rt.services.store.delete_document(document_id)

    @r.get("/documents/{document_id}/sections")
    def sections(request: Request, document_id: str) -> list[dict[str, Any]]:
        rt: Runtime = rt_of(request)
        _check_id(document_id)
        with rt.db.session() as s:
            rows = s.scalars(select(Section).where(Section.document_id == document_id).order_by(Section.ordinal)).all()
            return [
                {"id": x.id, "parentId": x.parent_id, "level": x.level, "title": x.title, "pageStart": x.page_start, "pageEnd": x.page_end}
                for x in rows
            ]

    @r.get("/documents/{document_id}/chunks")
    def chunks(request: Request, document_id: str, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=500)) -> dict[str, Any]:
        rt: Runtime = rt_of(request)
        _check_id(document_id)
        with rt.db.session() as s:
            total = s.scalar(select(func.count()).select_from(Chunk).where(Chunk.document_id == document_id)) or 0
            rows = s.scalars(select(Chunk).where(Chunk.document_id == document_id).order_by(Chunk.ordinal).offset(offset).limit(limit)).all()
            return {"total": total, "items": [Passage.of(c).json() for c in rows]}

    @r.post("/documents/{document_id}/search")
    def search(request: Request, document_id: str, body: SearchRequest) -> dict[str, Any]:
        """Hybrid retrieval within a document (optionally a section or page range), reranked by default."""
        rt: Runtime = rt_of(request)
        _require_ready(rt, document_id)
        res = Retriever(rt.db, rt.services, rt.settings).search(
            document_id, body.query, scope=body.scope, limit=body.limit, mode=body.mode, rerank=body.rerank
        )
        return {"query": body.query, "reranked": res.reranked, "reranker": res.reranker, "hits": [h.json() for h in res.hits]}

    @r.post("/documents/{document_id}/related")
    def related(request: Request, document_id: str, body: RelatedRequest) -> dict[str, Any]:
        """Passages related to a selection: the selection is the query and its own passage is excluded."""
        rt: Runtime = rt_of(request)
        _require_ready(rt, document_id)
        found = locate_selection(rt.db, document_id, body.text, body.page)
        res = Retriever(rt.db, rt.services, rt.settings).search(
            document_id, body.text[:2000], scope=body.scope, limit=body.limit, exclude=[found.passage.id] if found else ()
        )
        return {
            "selection": {"match": found.match, **found.passage.json()} if found else None,
            "reranked": res.reranked,
            "hits": [h.json() for h in res.hits],
        }

    @r.post("/documents/{document_id}/context")
    def context(request: Request, document_id: str, body: ContextRequest) -> dict[str, Any]:
        """The numbered sources an answer would be grounded in (what phase 3 sends to the model)."""
        rt: Runtime = rt_of(request)
        _require_ready(rt, document_id)
        res = Retriever(rt.db, rt.services, rt.settings).search(
            document_id, body.query, scope=body.scope, limit=body.limit, mode=body.mode, rerank=body.rerank
        )
        ctx = assemble_context([h.passage for h in res.hits], body.budget_tokens or rt.settings.context_budget_tokens)
        return {
            "query": body.query,
            "reranked": res.reranked,
            "tokenCount": ctx.token_count,
            "omitted": ctx.omitted,
            "sources": [x.json() for x in ctx.sources],
            "text": ctx.render(),
        }

    # Conversations (phase 3) ---------------------------------------------------------------------------

    @r.get("/documents/{document_id}/suggestions")
    def suggestions(request: Request, document_id: str) -> dict[str, Any]:
        """Starter questions for an empty chat (generated once per document, then stored)."""
        rt: Runtime = rt_of(request)
        _require_ready(rt, document_id)
        with rt.db.session() as s:
            stored = s.get(Document, document_id).suggested_questions  # type: ignore[union-attr]
        if stored:
            return {"questions": stored}
        _require_llm(rt)
        try:
            return {"questions": suggest_questions(rt.db, rt.services, rt.settings, document_id)}
        except LLMError as e:
            raise HTTPException(503 if e.retryable else 502, str(e)) from e

    @r.post("/documents/{document_id}/conversations", status_code=201)
    def create_conversation(request: Request, document_id: str, body: ConversationCreate) -> dict[str, Any]:
        rt: Runtime = rt_of(request)
        _require_ready(rt, document_id)
        conv = Conversation(id=str(uuid.uuid4()), document_id=document_id, title=body.title.strip())
        with rt.db.session() as s:
            s.add(conv)
            s.flush()
            return conversation_json(conv, 0)

    @r.get("/documents/{document_id}/conversations")
    def list_conversations(request: Request, document_id: str) -> list[dict[str, Any]]:
        rt: Runtime = rt_of(request)
        _check_id(document_id)
        with rt.db.session() as s:
            counts = select(Message.conversation_id, func.count().label("n")).group_by(Message.conversation_id).subquery()
            rows = s.execute(
                select(Conversation, counts.c.n)
                .outerjoin(counts, counts.c.conversation_id == Conversation.id)
                .where(Conversation.document_id == document_id)
                .order_by(Conversation.updated_at.desc())
            ).all()
            return [conversation_json(c, n or 0) for c, n in rows]

    @r.get("/conversations/{conversation_id}")
    def get_conversation(request: Request, conversation_id: str) -> dict[str, Any]:
        rt: Runtime = rt_of(request)
        with rt.db.session() as s:
            conv = s.get(Conversation, _check_uuid(conversation_id))
            if conv is None:
                raise HTTPException(404, "Conversation not found.")
            msgs = s.scalars(select(Message).where(Message.conversation_id == conv.id).order_by(Message.created_at)).all()
            return {**conversation_json(conv, len(msgs)), "messages": [message_json(m) for m in msgs]}

    @r.delete("/conversations/{conversation_id}", status_code=204)
    def delete_conversation(request: Request, conversation_id: str) -> None:
        rt: Runtime = rt_of(request)
        with rt.db.session() as s:
            conv = s.get(Conversation, _check_uuid(conversation_id))
            if conv is None:
                raise HTTPException(404, "Conversation not found.")
            s.delete(conv)

    @r.post("/conversations/{conversation_id}/messages")
    async def post_message(request: Request, conversation_id: str, body: MessageRequest) -> StreamingResponse:
        """Ask in a conversation. The answer streams back as server-sent events (see chat/service.py)."""
        rt: Runtime = rt_of(request)
        with rt.db.session() as s:
            conv = s.get(Conversation, _check_uuid(conversation_id))
            if conv is None:
                raise HTTPException(404, "Conversation not found.")
            document_id = conv.document_id
        _require_ready(rt, document_id)
        _require_llm(rt)
        turn = TurnRequest(
            content=body.content,
            mode=body.mode,
            selection=Selection(body.selection.text, body.selection.page) if body.selection else None,
            scope=body.scope,
        )
        gen = ChatService(rt.db, rt.services, rt.settings).run(conversation_id, turn)

        async def stream() -> AsyncIterator[str]:
            try:
                while True:
                    item = await run_in_threadpool(next, gen, None)
                    if item is None:
                        return
                    yield sse(*item)
            finally:
                # Closing the generator records a partial answer as `interrupted` if the reader went away.
                await run_in_threadpool(gen.close)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    return r


def _check_uuid(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise HTTPException(404, "Conversation not found.") from None


def create_app(settings: Settings | None = None, *, parser: Parser | None = None, services: Services | None = None, start_worker: bool = True) -> FastAPI:
    settings = settings or get_settings()
    settings.ensure_dirs()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await asyncio.to_thread(migrate, settings.db_url)
        db = Database(settings.db_url)
        requeued = recover(db)
        if requeued:
            log.info("re-queued %d interrupted ingestion job(s)", requeued)
        sv = services or Services(settings)
        if parser is None:
            from .ingestion.parsing import DoclingParser

            prs: Parser = DoclingParser(settings)
        else:
            prs = parser
        pipeline = Pipeline(db, settings, sv, prs)
        worker = Worker(db, pipeline, settings.max_auto_retries)
        quick_worker = Worker(db, pipeline, kind=JobKind.QUICK)
        if start_worker:
            worker.start()
            quick_worker.start()
        app.state.rt = Runtime(settings, db, sv, worker, quick_worker)
        try:
            yield
        finally:
            for w in (quick_worker, worker):
                w.stop()
            for w in (quick_worker, worker):
                if w.is_alive():
                    w.join(timeout=10)
            close = getattr(prs, "close", None)
            if close:
                await asyncio.to_thread(close)  # the warm Docling process, if any
            sv.close()
            db.engine.dispose()

    app = FastAPI(title="Folio AI", version="0.1.0", lifespan=lifespan)
    app.include_router(build_router(lambda request: request.app.state.rt))
    return app
