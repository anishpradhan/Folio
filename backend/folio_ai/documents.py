"""Document registration: receive the bytes, verify them, store them under their content hash."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from typing import BinaryIO

from sqlalchemy import delete

from .config import Settings
from .db import Chunk, Database, Document, DocumentStatus, Section

HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class UploadError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status        


@dataclass
class Registered:
    document: Document
    needs_ingestion: bool


def _store_upload(settings: Settings, stream: BinaryIO, claimed_hash: str | None) -> tuple[str, int]:
    """Copy the upload to disk while hashing it; returns (sha256, size)."""
    settings.ensure_dirs()
    h = hashlib.sha256()
    size = 0
    head = b""
    fd, tmp = tempfile.mkstemp(dir=settings.files_dir, suffix=".part")
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := stream.read(1024 * 1024):
                if len(head) < 1024:
                    head += chunk[: 1024 - len(head)]
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise UploadError(413, "This file is larger than the 600 MB limit.")
                h.update(chunk)
                out.write(chunk)
        if size == 0:
            raise UploadError(400, "The file is empty.")
        if b"%PDF-" not in head:
            raise UploadError(415, "Only PDF documents can be prepared for questions so far.")
        digest = h.hexdigest()
        if claimed_hash and claimed_hash.lower() != digest:
            raise UploadError(400, "The file didn't arrive intact (its fingerprint doesn't match). Try again.")
        final = settings.files_dir / f"{digest}.pdf"
        if final.exists():
            os.unlink(tmp)
        else:
            os.replace(tmp, final)
        return digest, size
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def register_upload(
    db: Database, settings: Settings, stream: BinaryIO, *, claimed_hash: str | None, title: str, file_name: str, embedding_model: str
) -> Registered:
    digest, size = _store_upload(settings, stream, claimed_hash)
    with db.session() as s:
        doc = s.get(Document, digest)
        if doc is None:
            doc = Document(id=digest, format="pdf", title=title.strip()[:500], file_name=file_name.strip()[:500], file_size=size, status=DocumentStatus.QUEUED)
            s.add(doc)
            return Registered(doc, True)
        if title and not doc.title:
            doc.title = title.strip()[:500]
        current = (
            doc.status == DocumentStatus.READY
            and doc.pipeline_version == settings.pipeline_version
            and doc.embedding_model == embedding_model
        )
        # Ready and current, or already in progress: nothing to do. Failed or stale: run again.
        return Registered(doc, not current and doc.status not in DocumentStatus.ACTIVE)


def delete_document(db: Database, settings: Settings, document_id: str) -> bool:
    with db.session() as s:
        doc = s.get(Document, document_id)
        if doc is None:
            return False
        s.execute(delete(Chunk).where(Chunk.document_id == document_id))
        s.execute(delete(Section).where(Section.document_id == document_id))
        s.delete(doc)
    for p in [settings.files_dir / f"{document_id}.pdf", *settings.parsed_dir.glob(f"{document_id}.*")]:
        p.unlink(missing_ok=True)
    return True
