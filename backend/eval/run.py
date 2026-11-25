"""Retrieval eval: Hit@k and MRR for dense, BM25, hybrid and hybrid + rerank on a question set.

Runs against a running backend (`npm run ai`), because embedded Qdrant allows only one process at a time.
The document is uploaded and ingested first if needed.

    backend/.venv/Scripts/python backend/eval/run.py [--set backend/eval/attention.json] [--k 8]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

BACKEND = Path(__file__).resolve().parent.parent
CONFIGS = {
    "dense": {"mode": "dense", "rerank": False},
    "bm25": {"mode": "bm25", "rerank": False},
    "hybrid": {"mode": "hybrid", "rerank": False},
    "hybrid+rerank": {"mode": "hybrid", "rerank": True},
}
CUTOFFS = (1, 3, 5, 8)


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s)).strip().casefold()


def relevant(text: str, evidence: list[str]) -> bool:
    t = norm(text)
    return any(norm(e) in t for e in evidence)


def ensure_ready(api: httpx.Client, pdf: Path, title: str) -> str:
    data = pdf.read_bytes()
    doc_id = hashlib.sha256(data).hexdigest()
    r = api.get(f"/documents/{doc_id}")
    if r.status_code == 404 or r.json()["status"] == "failed":
        print(f"Uploading {pdf.name} for ingestion…", flush=True)
        up = api.post("/documents", files={"file": (pdf.name, data, "application/pdf")}, data={"sha256": doc_id, "title": title})
        up.raise_for_status()
        if up.json()["status"] == "failed":
            api.post(f"/documents/{doc_id}/retry").raise_for_status()
    while True:
        d = api.get(f"/documents/{doc_id}").json()
        if d["status"] == "ready":
            return doc_id
        if d["status"] == "failed":
            sys.exit(f"Ingestion failed: {d['error']}")
        print(f"  {d['status']} {d['progress']:.0%} {d.get('detail') or ''}", flush=True)
        time.sleep(3)


def all_chunks(api: httpx.Client, doc_id: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    while True:
        page = api.get(f"/documents/{doc_id}/chunks", params={"offset": len(out), "limit": 500}).json()
        out.extend(page["items"])
        if len(out) >= page["total"] or not page["items"]:
            return out


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # the Windows console defaults to a legacy code page
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", default=str(BACKEND / "eval" / "attention.json"))
    ap.add_argument("--base", default="http://127.0.0.1:8765/api/ai")
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--only", choices=list(CONFIGS), action="append", help="run just these configurations")
    args = ap.parse_args()

    qset = json.loads(Path(args.set).read_text(encoding="utf-8"))
    api = httpx.Client(base_url=args.base, timeout=300)
    try:
        health = api.get("/health").json()
    except httpx.ConnectError:
        sys.exit("The backend isn't running. Start it with `npm run ai` (and `npm run ai:db`).")
    doc_id = ensure_ready(api, BACKEND / qset["document"]["file"], qset["document"]["title"])

    # The eval is only meaningful if every question's evidence exists in the indexed text.
    chunks = all_chunks(api, doc_id)
    missing = [q["id"] for q in qset["questions"] if not any(relevant(c["text"], q["evidence"]) for c in chunks)]
    if missing:
        sys.exit(f"Evidence not found in any indexed passage (fix the set or the chunking): {', '.join(missing)}")
    n_relevant = {q["id"]: sum(relevant(c["text"], q["evidence"]) for c in chunks) for q in qset["questions"]}

    configs = {k: v for k, v in CONFIGS.items() if not args.only or k in args.only}
    results: dict[str, Any] = {}
    for name, cfg in configs.items():
        per_q, times = [], []
        for q in qset["questions"]:
            t0 = time.perf_counter()
            r = api.post(f"/documents/{doc_id}/search", json={"query": q["q"], "limit": args.k, **cfg})
            times.append((time.perf_counter() - t0) * 1000)
            r.raise_for_status()
            body = r.json()
            if cfg["rerank"] and not body["reranked"]:
                sys.exit("Reranking was requested but the reranker isn't available (see the backend log).")
            ranks = [h["rank"] for h in body["hits"] if relevant(h["text"], q["evidence"])]
            per_q.append({"id": q["id"], "type": q["type"], "rank": ranks[0] if ranks else None, "top": [h["pageStart"] for h in body["hits"][:3]]})
        results[name] = {"questions": per_q, "latency_ms": {"median": statistics.median(times), "max": max(times)}}

    def metrics(rows: list[dict[str, Any]]) -> dict[str, float]:
        m = {f"hit@{c}": sum(1 for r in rows if r["rank"] and r["rank"] <= c) / len(rows) for c in CUTOFFS if c <= args.k}
        m[f"mrr@{args.k}"] = sum(1 / r["rank"] for r in rows if r["rank"]) / len(rows)
        return m

    cols = [f"hit@{c}" for c in CUTOFFS if c <= args.k] + [f"mrr@{args.k}"]
    print(f"\n{qset['name']}: {len(qset['questions'])} questions · embedding {health['embedding']['model']} · reranker {health['reranker']['model']}\n")
    print("| config | " + " | ".join(cols) + " | paraphrase hit@3 | lexical hit@3 | median ms |")
    print("| --- " * (len(cols) + 4) + "|")
    for name, res in results.items():
        m = metrics(res["questions"])
        res["metrics"] = m
        by_type = {t: metrics([r for r in res["questions"] if r["type"] == t]) for t in ("paraphrase", "lexical")}
        res["by_type"] = by_type
        row = [f"{m[c]:.3f}" for c in cols] + [f"{by_type['paraphrase']['hit@3']:.3f}", f"{by_type['lexical']['hit@3']:.3f}", f"{res['latency_ms']['median']:.0f}"]
        print(f"| {name} | " + " | ".join(row) + " |")

    print("\nQuestions not answered in the top 3 (rank, or – if not in the top k):")
    for name, res in results.items():
        misses = [f"{r['id']}({r['rank'] or '–'})" for r in res["questions"] if not r["rank"] or r["rank"] > 3]
        print(f"  {name:14} {', '.join(misses) or 'none'}")

    out_dir = BACKEND / "eval" / "results"
    out_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = out_dir / f"{qset['name']}-{stamp}.json"
    out.write_text(
        json.dumps({"set": qset["name"], "k": args.k, "embedding": health["embedding"], "reranker": health["reranker"]["model"], "relevant_passages": n_relevant, "results": results}, indent=2),
        encoding="utf-8",
    )
    print(f"\nSaved {out.relative_to(BACKEND)}")


if __name__ == "__main__":
    main()
