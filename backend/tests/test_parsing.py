"""The Docling child process: kept warm between documents, page progress, stall and cancel handling.

A stand-in replaces Docling in the child (same message protocol), so these run in a second, not minutes."""

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from folio_ai.config import Settings
from folio_ai.ingestion.parsing import DoclingParser
from folio_ai.ingestion.pipeline import IngestionError, eta_text


def stand_in(conn: Any, tables: bool, threads: int, hf_home: str, layout: str) -> None:
    """Like parsing._worker: 'ready', then per document 'progress'… and 'ok'. The file name steers it."""
    conn.send(("ready",))
    while True:
        try:
            msg = conn.recv()
        except EOFError:
            return
        if msg[0] != "parse":
            return
        _, pdf, out = msg
        name = Path(pdf).name
        if "stall" in name:
            time.sleep(60)
        if "broken" in name:
            conn.send(("err", "error", "ValueError: not a PDF"))
            continue
        for i in (1, 2, 3):
            if "slow" in name:
                time.sleep(0.4)
            conn.send(("progress", i, 3))
        Path(out).write_text(json.dumps({"pid": os.getpid(), "threads": threads}))
        conn.send(("ok", 3))


def make(tmp_path: Path, **kw: Any) -> DoclingParser:
    st = Settings(_env_file=None, data_dir=tmp_path, **kw)
    return DoclingParser(st, worker=stand_in)


def run(p: DoclingParser, tmp_path: Path, name: str, progress: list | None = None) -> dict:
    out = tmp_path / f"{name}.json"
    p.parse(str(tmp_path / name), str(out), on_progress=(lambda d, t: progress.append((d, t))) if progress is not None else None)
    return json.loads(out.read_text())


def test_the_reader_stays_loaded_between_documents_and_reports_pages(tmp_path: Path) -> None:
    p = make(tmp_path, parse_keep_warm_s=30, parse_threads=3)
    try:
        progress: list = []
        a = run(p, tmp_path, "a.pdf", progress)
        b = run(p, tmp_path, "b.pdf")
        assert a["pid"] == b["pid"] and a["threads"] == 3
        assert progress == [(1, 3), (2, 3), (3, 3)]
    finally:
        p.close()
    assert p._proc is None


def test_without_keep_warm_each_document_gets_a_fresh_process(tmp_path: Path) -> None:
    p = make(tmp_path, parse_keep_warm_s=0)
    assert run(p, tmp_path, "a.pdf")["pid"] != run(p, tmp_path, "b.pdf")["pid"]
    assert p._proc is None


def test_warming_starts_the_reader_that_the_next_parse_uses(tmp_path: Path) -> None:
    for keep_warm in (30, 0):
        p = make(tmp_path, parse_keep_warm_s=keep_warm)
        try:
            p.warm()
            assert p._proc is not None and p._proc.is_alive()
            pid = p._proc.pid
            p.warm()  # already loading: the same process
            assert p._proc.pid == pid
            assert run(p, tmp_path, "a.pdf")["pid"] == pid
            assert (p._proc is None) == (keep_warm == 0)
        finally:
            p.close()


def test_an_idle_reader_exits(tmp_path: Path) -> None:
    p = make(tmp_path, parse_keep_warm_s=1)
    run(p, tmp_path, "a.pdf")
    proc = p._proc
    assert proc is not None and proc.is_alive()
    deadline = time.time() + 10
    while p._proc is not None and time.time() < deadline:
        time.sleep(0.1)
    assert p._proc is None
    proc.join(timeout=10)
    assert not proc.is_alive()


def test_a_stalled_parse_is_stopped_and_the_process_replaced(tmp_path: Path) -> None:
    p = make(tmp_path, parse_keep_warm_s=30, parse_stall_s=1)
    try:
        with pytest.raises(IngestionError, match="stopped making progress"):
            run(p, tmp_path, "stall.pdf")
        assert p._proc is None  # killed, not reused
        p.settings.parse_stall_s = 120  # a fresh process takes a few seconds to start
        assert run(p, tmp_path, "after.pdf")["pid"] > 0
    finally:
        p.close()


def test_a_failed_document_reports_its_reason(tmp_path: Path) -> None:
    p = make(tmp_path, parse_keep_warm_s=30)
    try:
        with pytest.raises(IngestionError, match="not a PDF"):
            run(p, tmp_path, "broken.pdf")
    finally:
        p.close()


def test_cancel_stops_a_running_parse(tmp_path: Path) -> None:
    p = make(tmp_path, parse_keep_warm_s=30)
    progress: list = []
    threading.Timer(0.6, p.cancel).start()
    with pytest.raises(IngestionError, match="cancelled"):
        run(p, tmp_path, "slow-stall.pdf", progress)
    assert p._proc is None


def test_eta_text() -> None:
    assert eta_text(3) == "about 10 s left"
    assert eta_text(41) == "about 50 s left"
    assert eta_text(95) == "about 2 min left"
    assert eta_text(12 * 60 + 1) == "about 13 min left"
