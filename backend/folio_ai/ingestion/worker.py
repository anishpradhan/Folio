"""Durable job queue (the `ingestion_jobs` table) and the background workers that drain it: one for quick
passes (text layer, seconds) and one for full Docling passes (minutes), so a long book being read never
holds up the next upload's quick pass."""

from __future__ import annotations

import logging
import threading
import traceback
import uuid
from datetime import timedelta

from sqlalchemy import exists, or_, select, update
from sqlalchemy.orm import aliased

from ..config import Settings
from ..db import Database, Document, DocumentStatus, IndexKind, IngestionJob, JobKind, JobStatus, utcnow
from ..embeddings import TransientError
from .pipeline import IngestionError, Pipeline

log = logging.getLogger("folio_ai.worker")

RETRY_BACKOFF_S = (15, 60, 240)

OUT_OF_MEMORY_MESSAGE = (
    "The computer ran out of memory while preparing the document. "
    "Close some apps or browser tabs; it will be retried automatically."
)
_OOM_MARKERS = ("failed to allocate memory", "os error 1455", "paging file", "not enough memory", "out of memory")


def is_out_of_memory(e: BaseException) -> bool:
    """MemoryError, or an allocation failure reported as text (ONNX Runtime, Torch, Windows commit limit)."""
    if isinstance(e, MemoryError):
        return True
    text = str(e).lower()
    return any(m in text for m in _OOM_MARKERS)


ACTIVE_JOB = (JobStatus.QUEUED, JobStatus.RUNNING)


def enqueue(db: Database, document_id: str, *, force: bool = False, attempt: int = 1, delay_s: float = 0, kind: str = JobKind.FULL) -> IngestionJob:
    """Queue a job of this kind for a document unless one is already queued or running."""
    with db.session() as s:
        active = s.scalars(
            select(IngestionJob).where(IngestionJob.document_id == document_id, IngestionJob.kind == kind, IngestionJob.status.in_(ACTIVE_JOB))
        ).first()
        if active:
            return active
        job = IngestionJob(
            id=str(uuid.uuid4()),
            document_id=document_id,
            kind=kind,
            attempt=attempt,
            force=force,
            not_before=utcnow() + timedelta(seconds=delay_s) if delay_s else None,
        )
        s.add(job)
        doc = s.get(Document, document_id)
        if doc and doc.status == DocumentStatus.READY and doc.index_kind == IndexKind.QUICK:
            # Still answering from the quick pass while the full one waits: it stays ready.
            doc.error = None
            doc.progress = 0.0
            doc.status_detail = f"Retrying in {int(delay_s)} s" if delay_s else "Waiting to read headings and tables"
        elif doc:
            doc.status = DocumentStatus.QUEUED
            doc.progress = 0.0
            doc.error = None
            doc.status_detail = f"Retrying in {int(delay_s)} s" if delay_s else "Waiting to start"
        return job


def enqueue_document(db: Database, settings: Settings, document_id: str, *, force: bool = False) -> IngestionJob:
    """Prepare a document: a quick pass first when it has nothing searchable yet, then the full pass.
    Returns the full pass's job."""
    if settings.quick_index:
        with db.session() as s:
            doc = s.get(Document, document_id)
            needs_quick = doc is not None and doc.index_kind is None
        if needs_quick:
            enqueue(db, document_id, kind=JobKind.QUICK)
    return enqueue(db, document_id, force=force)


def recover(db: Database) -> int:
    """After a restart, jobs that were mid-run go back to the queue."""
    with db.session() as s:
        res = s.execute(update(IngestionJob).where(IngestionJob.status == JobStatus.RUNNING).values(status=JobStatus.QUEUED, started_at=None))
        s.execute(
            update(Document)
            .where(Document.status.in_(DocumentStatus.ACTIVE))
            .values(status=DocumentStatus.QUEUED, progress=0.0, status_detail="Waiting to start")
        )
        return res.rowcount or 0


class Worker(threading.Thread):
    def __init__(self, db: Database, pipeline: Pipeline, max_auto_retries: int = 3, poll_s: float = 1.0, kind: str = JobKind.FULL):
        super().__init__(name="folio-ingestion" if kind == JobKind.FULL else "folio-quick", daemon=True)
        self.kind = kind
        self.db = db
        self.pipeline = pipeline
        self.max_auto_retries = max_auto_retries
        self.poll_s = poll_s
        self._wake = threading.Event()
        self._stop = threading.Event()

    def wake(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self.kind == JobKind.FULL:
            self.pipeline.cancel()  # the Docling process

    def run(self) -> None:
        while not self._stop.is_set():
            try:
                job_id = self._claim()
            except Exception:  # database hiccup: keep the worker alive
                log.exception("claiming a job failed")
                job_id = None
            if job_id is None:
                self._wake.wait(self.poll_s)
                self._wake.clear()
                continue
            self.process(job_id)

    def _claim(self) -> str | None:
        """Take the oldest due job of this worker's kind. SKIP LOCKED makes this safe even with several workers
        or processes. A full pass waits until the document's quick pass is over."""
        now = utcnow()
        with self.db.session() as s:
            conds = [
                IngestionJob.kind == self.kind,
                IngestionJob.status == JobStatus.QUEUED,
                or_(IngestionJob.not_before.is_(None), IngestionJob.not_before <= now),
            ]
            if self.kind == JobKind.FULL:
                quick = aliased(IngestionJob)
                conds.append(
                    ~exists().where(quick.document_id == IngestionJob.document_id, quick.kind == JobKind.QUICK, quick.status.in_(ACTIVE_JOB))
                )
            job = s.scalars(
                select(IngestionJob)
                .where(*conds)
                .order_by(IngestionJob.created_at)
                .limit(1)
                .with_for_update(skip_locked=True)
            ).first()
            if job is None:
                return None
            job.status = JobStatus.RUNNING
            job.started_at = now
            return job.id

    def process(self, job_id: str) -> None:
        with self.db.session() as s:
            job = s.get(IngestionJob, job_id)
            assert job is not None
            document_id, attempt, force = job.document_id, job.attempt, job.force

        def stage(name: str) -> None:
            with self.db.session() as s:
                s.execute(update(IngestionJob).where(IngestionJob.id == job_id).values(stage=name))

        if self.kind == JobKind.QUICK:
            self._process_quick(job_id, document_id, stage)
            return
        try:
            self.pipeline.run(document_id, force=force, on_stage=stage)
        except Exception as e:  # noqa: BLE001 — every failure is recorded on the job and the document
            if self._stop.is_set():
                self._finish(job_id, JobStatus.QUEUED, None, None)  # shutting down: resume next start
                return
            oom = not isinstance(e, IngestionError) and is_out_of_memory(e)
            transient = isinstance(e, TransientError) or oom
            if oom:
                message = OUT_OF_MEMORY_MESSAGE
            elif isinstance(e, (IngestionError, TransientError, RuntimeError)):
                message = str(e)
            else:
                message = "Unexpected error while preparing the document."
            if not isinstance(e, (IngestionError, TransientError)):
                log.error("ingestion of %s failed:\n%s", document_id, traceback.format_exc())
            self._finish(job_id, JobStatus.FAILED, message, "transient" if transient else "permanent")
            if transient and attempt <= self.max_auto_retries:
                delay = RETRY_BACKOFF_S[min(attempt - 1, len(RETRY_BACKOFF_S) - 1)]
                enqueue(self.db, document_id, force=force, attempt=attempt + 1, delay_s=delay)
            else:
                self._fail_document(document_id, message)
            return
        self._finish(job_id, JobStatus.SUCCEEDED, None, None)

    def _process_quick(self, job_id: str, document_id: str, stage: object) -> None:
        """A quick pass is a head start, never the verdict: whatever goes wrong, the full pass still runs and
        reports problems (a locked or broken PDF fails there with the same message)."""
        try:
            self.pipeline.run_quick(document_id, on_stage=stage)  # type: ignore[arg-type]
        except Exception as e:  # noqa: BLE001
            if not isinstance(e, IngestionError):
                log.warning("quick pass of %s failed:\n%s", document_id, traceback.format_exc())
            self._finish(job_id, JobStatus.QUEUED if self._stop.is_set() else JobStatus.FAILED, str(e)[:2000], "quick")
            with self.db.session() as s:
                doc = s.get(Document, document_id)
                if doc and doc.status in DocumentStatus.ACTIVE:
                    doc.status = DocumentStatus.QUEUED
                    doc.progress = 0.0
                    doc.status_detail = "Waiting to start"
            return
        self._finish(job_id, JobStatus.SUCCEEDED, None, None)

    def _finish(self, job_id: str, status: str, error: str | None, kind: str | None) -> None:
        with self.db.session() as s:
            job = s.get(IngestionJob, job_id)
            if job:
                job.status = status
                job.error = error
                job.error_kind = kind
                job.finished_at = None if status == JobStatus.QUEUED else utcnow()
                if status == JobStatus.QUEUED:
                    job.started_at = None

    def _fail_document(self, document_id: str, message: str) -> None:
        with self.db.session() as s:
            doc = s.get(Document, document_id)
            if doc and doc.status == DocumentStatus.READY and doc.index_kind == IndexKind.QUICK:
                # The full pass failed, but the quick passages still answer questions.
                doc.error = message
                doc.status_detail = None
                doc.progress = 0.0
            elif doc:
                doc.status = DocumentStatus.FAILED
                doc.error = message
                doc.status_detail = None
                doc.progress = 0.0
