"""Live smoke test of the chat API against the running backend. Makes real Claude calls (a few cents).

    backend/.venv/Scripts/python backend/eval/smoke_chat.py

Asks a question, a follow-up, an out-of-scope question and an explain-selection on the bench paper, prints
timing, answers and resolved citations, then deletes the conversation it created."""

import hashlib
import json
import sys
import time
from pathlib import Path

import httpx

sys.stdout.reconfigure(encoding="utf-8")
BASE = "http://127.0.0.1:8765/api/ai"
DOC = hashlib.sha256((Path(__file__).resolve().parent.parent / "data" / "bench" / "attention.pdf").read_bytes()).hexdigest()
api = httpx.Client(base_url=BASE, timeout=300)


def turn(conv: str, label: str, **body):
    print(f"\n=== {label} ===")
    t0 = time.perf_counter()
    first = None
    text = []
    cits = []
    with api.stream("POST", f"/conversations/{conv}/messages", json=body) as r:
        if r.status_code != 200:
            print("HTTP", r.status_code, r.read().decode()[:300])
            return None
        event = None
        for line in r.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
                if event == "sources":
                    print("sources:", [(s["n"], " > ".join(s["headingPath"])[-45:], s["pageStart"]) for s in data])
                elif event == "status":
                    print(f"  [{time.perf_counter() - t0:5.1f}s] {data['state']}")
                elif event == "delta":
                    if first is None:
                        first = time.perf_counter() - t0
                    text.append(data["text"])
                elif event == "citation":
                    cits.append(data)
                elif event in ("done", "error"):
                    print(f"  [{time.perf_counter() - t0:5.1f}s] {event}: {json.dumps({k: v for k, v in data.items() if k != 'usage'})}")
                    if event == "done":
                        u = data["usage"]
                        print(f"  usage: in={u.get('input_tokens')} out={u.get('output_tokens')} model={data['model']}")
    answer = "".join(text)
    print(f"  first token after {first:.1f}s" if first else "  no text")
    print("ANSWER:\n" + answer)
    for c in cits:
        print(f"  [{c['id']}] p.{c['page']} src{c['source']} span[{c['start']}:{c['end']}] rects={len(c['locations'])} quote={c['quote'][:90]!r}")
        assert answer[c["start"] : c["end"]], "empty span"
    return answer, cits


def main() -> None:
    print("health:", api.get("/health").json()["llm"])
    t0 = time.perf_counter()
    r = api.get(f"/documents/{DOC}/suggestions")
    print(f"suggestions ({time.perf_counter() - t0:.1f}s):", r.status_code, json.dumps(r.json(), ensure_ascii=False))

    conv = api.post(f"/documents/{DOC}/conversations", json={}).json()["id"]
    try:
        turn(conv, "question", content="Why do they scale the dot products in attention?")
        turn(conv, "follow-up", content="And how many heads does the base model use for it?")
        turn(conv, "out of scope", content="What GPU would I need to train GPT-4?")
        turn(
            conv,
            "explain a selection",
            mode="explain",
            selection={
                "text": "We suspect that for large values of dk, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients",
                "page": 4,
            },
        )
        msgs = api.get(f"/conversations/{conv}").json()["messages"]
        print("\nstored:", [(m["role"], m["mode"], m["status"], len(m["citations"])) for m in msgs])
        follow = msgs[3]["retrieval"] or {}
        print("follow-up search query:", follow.get("query"), "| rewritten:", follow.get("rewritten"))
    finally:
        api.delete(f"/conversations/{conv}")


if __name__ == "__main__":
    main()
