"""Folio AI backend: document ingestion, retrieval and (later) grounded chat for the Folio reader."""

import os

# Windows without Developer Mode can't create the symlinks the Hugging Face cache prefers; copies work fine.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
