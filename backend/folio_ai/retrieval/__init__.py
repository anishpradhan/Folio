"""Retrieval (responsibility 5): scoped hybrid search, reranking, selection lookup and context assembly."""

from .context import Context, Source, assemble_context
from .locate import Located, locate_selection
from .reranker import CrossEncoderReranker, Reranker
from .retriever import RetrievedChunk, Retriever, Scope

__all__ = [
    "Context",
    "CrossEncoderReranker",
    "Located",
    "Reranker",
    "RetrievedChunk",
    "Retriever",
    "Scope",
    "Source",
    "assemble_context",
    "locate_selection",
]
