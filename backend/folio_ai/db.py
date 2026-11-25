"""PostgreSQL engine, session factory, ORM models and migrations (Alembic, applied on start-up)."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Iterator

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Index, Integer, String, Text, create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSONB, list[Any]: JSONB}


class DocumentStatus:
    QUEUED = "queued"
    PARSING = "parsing"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    INDEXING = "indexing"
    READY = "ready"
    FAILED = "failed"

    ACTIVE = (QUEUED, PARSING, CHUNKING, EMBEDDING, INDEXING)


class IndexKind:
    """What a ready document's passages come from."""

    QUICK = "quick"  # the PDF's text layer (pdfium), ready in seconds; the full pass replaces it
    FULL = "full"  # Docling's layout: headings, sections, tables


class Document(Base):
    __tablename__ = "documents"

    # SHA-256 of the original bytes: the identity shared with the browser (DocumentRecord.fileHash).
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    format: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(Text, default="")
    file_name: Mapped[str] = mapped_column(Text, default="")
    file_size: Mapped[int] = mapped_column(BigInteger)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[str] = mapped_column(String(16), default=DocumentStatus.QUEUED, index=True)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    status_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    pipeline_version: Mapped[int] = mapped_column(Integer, default=0)
    embedding_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    # IndexKind of the searchable passages; None until the first pass finishes.
    index_kind: Mapped[str | None] = mapped_column(String(8), nullable=True)
    suggested_questions: Mapped[list[Any] | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    jobs: Mapped[list[IngestionJob]] = relationship(back_populates="document", cascade="all, delete-orphan", passive_deletes=True)


class JobStatus:
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobKind:
    QUICK = "quick"
    FULL = "full"


class IngestionJob(Base):
    __tablename__ = "ingestion_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default=JobStatus.QUEUED, index=True)
    # JobKind: the quick text pass or the full Docling pass (separate workers, quick first).
    kind: Mapped[str] = mapped_column(String(8), default="full", server_default="full")
    stage: Mapped[str | None] = mapped_column(String(16), nullable=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    # Re-run every stage even if cached results exist.
    force: Mapped[bool] = mapped_column(default=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    not_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    document: Mapped[Document] = relationship(back_populates="jobs")


class Section(Base):
    __tablename__ = "sections"
    __table_args__ = (Index("ix_sections_document_ordinal", "document_id", "ordinal", unique=True),)

    id: Mapped[str] = mapped_column(String(96), primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("sections.id", ondelete="CASCADE"), nullable=True)
    ordinal: Mapped[int] = mapped_column(Integer)
    level: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(Text)
    page_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_end: Mapped[int | None] = mapped_column(Integer, nullable=True)


class Chunk(Base):
    __tablename__ = "chunks"
    __table_args__ = (Index("ix_chunks_document_ordinal", "document_id", "ordinal", unique=True),)

    id: Mapped[str] = mapped_column(String(96), primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)
    section_id: Mapped[str | None] = mapped_column(ForeignKey("sections.id", ondelete="SET NULL"), nullable=True, index=True)
    heading_path: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    text: Mapped[str] = mapped_column(Text)
    embed_text: Mapped[str] = mapped_column(Text)
    page_start: Mapped[int] = mapped_column(Integer)
    page_end: Mapped[int] = mapped_column(Integer)
    # [{page, rect: {x, y, w, h}} …] normalised to 0..1, top-left origin (same space as Highlight.rects).
    locations: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    token_count: Mapped[int] = mapped_column(Integer)
    kinds: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    # Sentence-sized pieces of `text` with their page rectangles: the units an answer cites.
    blocks: Mapped[list[Any]] = mapped_column(JSONB, default=list, server_default="[]")


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    mode: Mapped[str] = mapped_column(String(16), default="chat")
    scope: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    citations: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    retrieval: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    usage: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    # complete | interrupted (client went away mid-answer) | refused | error
    status: Mapped[str] = mapped_column(String(16), default="complete", server_default="complete")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def migrate(url: str) -> None:
    """Bring the schema up to date (idempotent; safe to run on every start)."""
    from alembic import command
    from alembic.config import Config

    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    cfg.attributes["url"] = url
    command.upgrade(cfg, "head")


class Database:
    """Owns the engine and session factory; one per app (tests create their own)."""

    def __init__(self, url: str):
        if not url.startswith("postgresql"):
            raise ValueError("Folio AI needs PostgreSQL: set DATABASE_URL (or the POSTGRES_* settings) in backend/.env.")
        # API threads + the ingestion worker + SSE pollers share a small pool.
        self.engine: Engine = create_engine(url, pool_size=5, max_overflow=10, pool_pre_ping=True)
        self.sessions = sessionmaker(self.engine, expire_on_commit=False)

    @contextmanager
    def session(self) -> Iterator[Session]:
        with self.sessions() as s:
            try:
                yield s
                s.commit()
            except BaseException:
                s.rollback()
                raise
