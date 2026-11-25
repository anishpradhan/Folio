"""Docling PDF parsing, run in a child process.

The layout/table models need ~1–2 GB of memory and can take minutes on a laptop CPU. A child process keeps
that memory out of the API process and lets a stuck or cancelled parse be killed outright.

The child stays warm for `parse_keep_warm_s` after a document (default 5 minutes), so several uploads in a
row load the models once; then it exits and its memory goes back to the OS. It reports each finished page,
which drives the progress bar, and a parse is stopped when no page finishes for `parse_stall_s`.
"""

from __future__ import annotations

import multiprocessing as mp
import os
import threading
import time
from typing import Any, Callable

from ..config import Settings

ProgressFn = Callable[[int, int], None]


class ParseError(Exception):
    pass


def _error_kind(e: BaseException, text: str) -> str:
    low = text.lower()
    if "password" in low or "encrypt" in low:
        return "encrypted"
    # Windows "paging file is too small" (os error 1455) or a plain MemoryError while loading models.
    if isinstance(e, MemoryError) or "os error 1455" in low or "paging file" in low or "not enough memory" in low:
        return "memory"
    return "error"


def _worker(conn: Any, tables: bool, threads: int, hf_home: str, layout: str) -> None:
    """The child: load Docling once, then convert documents on request until told to stop or killed."""
    os.environ.setdefault("HF_HOME", hf_home)  # keep downloaded models under backend/data/models
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    send_lock = threading.Lock()

    def send(msg: tuple[Any, ...]) -> None:
        with send_lock:  # progress can arrive from the pipeline's worker threads
            conn.send(msg)

    try:
        from docling.datamodel.accelerator_options import AcceleratorOptions
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import LayoutObjectDetectionOptions, PdfPipelineOptions, TableFormerMode
        from docling.datamodel.progress import ConversionProgressKind
        from docling.document_converter import DocumentConverter, PdfFormatOption

        opts = PdfPipelineOptions()
        opts.do_ocr = False  # research PDFs have a text layer; scanned PDFs are reported, not OCR'd (yet)
        opts.do_table_structure = tables
        if tables:
            opts.table_structure_options.mode = TableFormerMode.FAST
        opts.generate_page_images = False
        opts.layout_options = LayoutObjectDetectionOptions.from_preset(layout)
        opts.accelerator_options = AcceleratorOptions(num_threads=threads, device="cpu")
        conv = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})
        conv.initialize_pipeline(InputFormat.PDF)  # load the models now, not on the first page
    except BaseException as e:  # noqa: BLE001 — reported to the parent as a message
        text = f"{e.__class__.__name__}: {e}"
        send(("err", _error_kind(e, text), text[:2000]))
        conn.close()
        return
    send(("ready",))

    while True:
        try:
            msg = conn.recv()
        except (EOFError, OSError):
            return  # the parent went away
        if msg[0] != "parse":
            return
        _, pdf_path, out_json = msg

        def progress(ev: Any) -> None:
            if ev.kind == ConversionProgressKind.PAGE_COMPLETED:
                send(("progress", ev.completed_pages, ev.total_pages))

        try:
            res = conv.convert(pdf_path, raises_on_error=True, progress_callback=progress)
            res.document.save_as_json(out_json)
            send(("ok", len(res.document.pages)))
        except BaseException as e:  # noqa: BLE001
            text = f"{e.__class__.__name__}: {e}"
            kind = _error_kind(e, text)
            send(("err", kind, text[:2000]))
            if kind == "memory":
                return  # start from a fresh process next time


class DoclingParser:
    def __init__(self, settings: Settings, worker: Callable[..., None] = _worker):
        self.settings = settings
        self._target = worker  # tests substitute a stand-in for the Docling child
        self._proc: mp.process.BaseProcess | None = None
        self._conn: Any = None
        self._ready = False
        self._lock = threading.Lock()  # one parse at a time
        self._cancel = threading.Event()
        self._idle: threading.Timer | None = None

    # -- the child process ---------------------------------------------------------------------
    def _start(self) -> None:
        ctx = mp.get_context("spawn")
        parent, child = ctx.Pipe(duplex=True)
        hf_home = str(self.settings.models_dir / "hf")
        threads = self.settings.parse_threads or os.cpu_count() or 4
        p = ctx.Process(target=self._target, args=(child, self.settings.parse_tables, threads, hf_home, self.settings.parse_layout_model), daemon=True)
        p.start()
        child.close()
        self._proc, self._conn, self._ready = p, parent, False

    def _stop(self) -> None:
        p, conn = self._proc, self._conn
        self._proc, self._conn, self._ready = None, None, False
        if conn is not None:
            try:
                conn.send(("stop",))
            except (OSError, BrokenPipeError):
                pass
        if p is not None:
            p.join(timeout=5)
            if p.is_alive():
                p.kill()
                p.join(timeout=5)
        if conn is not None:
            conn.close()

    def _kill(self) -> None:
        p = self._proc
        if p is not None and p.is_alive():
            p.kill()
        self._stop()

    def _stop_if_idle(self) -> None:
        if self._lock.acquire(blocking=False):
            try:
                self._stop()
            finally:
                self._lock.release()

    def warm(self) -> None:
        """Start loading the document reader ahead of a parse, so its start-up (half a minute on a laptop)
        overlaps the quick pass. A no-op while a parse runs; the process exits if no parse comes."""
        if not self._lock.acquire(blocking=False):
            return  # a parse is running: the reader is loaded
        try:
            if self._proc is None or not self._proc.is_alive():
                self._stop()
                self._start()
            if self._idle:
                self._idle.cancel()
            self._idle = threading.Timer(max(self.settings.parse_keep_warm_s, 120), self._stop_if_idle)
            self._idle.daemon = True
            self._idle.start()
        finally:
            self._lock.release()

    def close(self) -> None:
        if self._idle:
            self._idle.cancel()
        with self._lock:
            self._stop()

    def cancel(self) -> None:
        self._cancel.set()
        p = self._proc
        if p is not None and p.is_alive():
            p.kill()

    # -- parsing ---------------------------------------------------------------------------------
    def parse(self, pdf_path: str, out_json: str, on_progress: ProgressFn | None = None) -> None:
        from .pipeline import IngestionError

        with self._lock:
            if self._idle:
                self._idle.cancel()
            self._cancel.clear()
            if self._proc is None or not self._proc.is_alive():
                self._stop()
                self._start()
            ok = False
            try:
                self._conn.send(("parse", pdf_path, out_json))
                msg = self._wait(on_progress)
                ok = msg is not None and msg[0] == "ok"
            except (OSError, BrokenPipeError):
                msg = None
            finally:
                if not ok or self.settings.parse_keep_warm_s <= 0:
                    self._kill()  # a failed, cancelled or stuck child is not reused
                else:
                    self._idle = threading.Timer(self.settings.parse_keep_warm_s, self._stop_if_idle)
                    self._idle.daemon = True
                    self._idle.start()

        if msg is None:
            if self._cancel.is_set():
                raise IngestionError("Preparation was cancelled.")
            raise IngestionError("The document reader stopped unexpectedly — the computer may be low on memory.")
        if msg[0] == "err":
            if msg[1] == "encrypted":
                raise IngestionError("This PDF is password-protected, so it can't be read.")
            if msg[1] == "memory":
                raise IngestionError(
                    "The computer ran out of memory while loading the document reader (it needs about 2 GB free). "
                    "Close some apps or browser tabs, then try again."
                )
            raise IngestionError(f"The PDF couldn't be read ({msg[2][:300]}).")

    def _wait(self, on_progress: ProgressFn | None) -> tuple[Any, ...] | None:
        """Relay progress until the child answers. None when it died, was cancelled or stalled."""
        from .pipeline import IngestionError

        st = self.settings
        started = last = time.monotonic()
        conn, p = self._conn, self._proc
        assert conn is not None and p is not None
        while True:
            if conn.poll(0.5):
                try:
                    msg = conn.recv()
                except (EOFError, OSError):
                    return None
                last = time.monotonic()
                if msg[0] == "ready":
                    self._ready = True
                elif msg[0] == "progress":
                    if on_progress:
                        on_progress(int(msg[1]), int(msg[2]))
                else:
                    return msg
                continue
            if not p.is_alive() or self._cancel.is_set():
                return None
            now = time.monotonic()
            if now - last > st.parse_stall_s:
                span = f"{st.parse_stall_s // 60} minutes" if st.parse_stall_s >= 120 else f"{st.parse_stall_s} seconds"
                raise IngestionError(f"Reading the document stopped making progress (no page finished in {span}), so it was stopped.")
            if now - started > st.parse_timeout_s:
                raise IngestionError(f"Reading the document took longer than {st.parse_timeout_s // 3600} hours and was stopped.")
