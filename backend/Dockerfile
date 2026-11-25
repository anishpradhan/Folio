# syntax=docker/dockerfile:1
# Folio AI backend: FastAPI + Docling (CPU) + local embeddings + embedded Qdrant.
# Built and run by the root docker-compose.yml; see the README section "Run everything with Docker".
FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# OpenMP for PyTorch and ONNX Runtime; GLib for OpenCV (used by Docling for page images).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The lock file is made on Windows: drop its Windows-only packages. The "+cpu" PyTorch builds come from
# PyTorch's own index (CPU-only wheels; no multi-gigabyte CUDA libraries).
COPY requirements.lock.txt ./
RUN grep -v -E '^(pywin32|win32[-_]setctime)==' requirements.lock.txt > requirements.linux.txt \
 && pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.linux.txt

COPY folio_ai ./folio_ai

# Documents, parses and the vector index live in /data; downloaded models (~1 GB, fetched on first use)
# in /models. Both are volumes, so rebuilding the image keeps them.
RUN useradd --create-home --uid 10001 folio \
 && mkdir -p /data /models \
 && chown folio:folio /data /models
USER folio

ENV HOST=0.0.0.0 \
    PORT=8765 \
    DATA_DIR=/data \
    MODELS_PATH=/models

EXPOSE 8765
# Generous start period: the first start applies database migrations.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/ai/health', timeout=4)"]

CMD ["python", "-m", "folio_ai"]
