"""Chat turns (responsibility 7): retrieval or selection context -> grounded, cited, streamed answer -> stored.

`ChatService.run` is a generator of (event, data) pairs for the SSE route:

    start     {conversationId, userMessageId, mode}
    sources   [{n, headingPath, pageStart, pageEnd, chunkIds}]      before generation, so the UI can show them
    status    {state: "thinking"}                                   the model is reasoning (no text yet)
    delta     {text}                                                answer text, in order
    citation  {id, source, chunkId, page, locations, quote, start, end, headingPath}
              the answer text [start, end) is supported by `quote` on `page` (rectangles in `locations`)
    done      {messageId, status, stopReason, model, usage}
    error     {message, retryable}                                  instead of `done`

The user message is stored before generation; the assistant message is stored when generation ends,
including when it fails or the client disconnects (status `error` / `interrupted`)."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Iterator, Literal

from sqlalchemy import select

from ..config import Settings
from ..db import Chunk, Conversation, Database, Document, Message, utcnow
from ..llm import Citation, Finished, LLMError, SourceDoc, SpanEnd, TextDelta, Thinking, Turn
from ..retrieval import Retriever, Scope, assemble_context, locate_selection
from ..retrieval.context import Context, Source
from ..retrieval.retriever import Passage
from ..services import Services
from . import prompts

log = logging.getLogger("folio_ai.chat")

Mode = Literal["chat", "explain", "summarize", "simplify", "ask"]
SELECTION_MODES = ("explain", "summarize", "simplify", "ask")
ANSWERED = ("complete", "interrupted")


@dataclass
class Selection:
    text: str
    page: int | None = None


@dataclass
class TurnRequest:
    content: str = ""
    mode: Mode = "chat"
    selection: Selection | None = None
    scope: Scope = Scope()


class ChatService:
    def __init__(self, db: Database, services: Services, settings: Settings):
        self.db = db
        self.services = services
        self.settings = settings

    # The turn -------------------------------------------------------------------------------------------

    def run(self, conversation_id: str, req: TurnRequest) -> Iterator[tuple[str, dict[str, Any]]]:
        st = self.settings
        llm = self.services.get_llm()
        with self.db.session() as s:
            conv = s.get(Conversation, conversation_id)
            assert conv is not None, "the route checks the conversation exists"
            doc = s.get(Document, conv.document_id)
            assert doc is not None
            document_id, doc_title = doc.id, doc.title or doc.file_name or "the document"
        history = self._history(conversation_id)
        question = req.content.strip() or prompts.DEFAULT_QUESTIONS.get(req.mode, "")
        user_id = self._save_user(conversation_id, question, req)
        yield "start", {"conversationId": conversation_id, "userMessageId": user_id, "mode": req.mode}

        answer: list[str] = []
        citations: list[dict[str, Any]] = []
        retrieval: dict[str, Any] = {"mode": req.mode}
        finished: Finished | None = None
        status = "error"
        try:
            ctx = self._context(document_id, req, question, history, retrieval)
            yield "sources", [_source_summary(x) for x in ctx.sources]
            docs = [_source_doc(x, doc_title) for x in ctx.sources]
            pending: list[dict[str, Any]] = []
            length = span_start = 0
            thinking_sent = False
            dropped = 0
            for ev in llm.stream_answer(
                system=prompts.ANSWER_SYSTEM,
                history=history if req.mode in ("chat", "ask") else [],
                sources=docs,
                prompt=prompts.turn_prompt(req.mode, question, req.selection.text if req.selection else None),
                effort=st.llm_effort,
            ):
                if isinstance(ev, Thinking):
                    if not thinking_sent:
                        thinking_sent = True
                        yield "status", {"state": "thinking"}
                elif isinstance(ev, TextDelta):
                    answer.append(ev.text)
                    length += len(ev.text)
                    yield "delta", {"text": ev.text}
                elif isinstance(ev, Citation):
                    c = resolve_citation(ctx, ev)
                    if c is None:
                        dropped += 1
                    elif not any(_same(c, p) for p in pending):
                        pending.append(c)
                elif isinstance(ev, SpanEnd):
                    for c in pending:
                        c.update(id=len(citations) + 1, start=span_start, end=length)
                        citations.append(c)
                        yield "citation", c
                    pending = []
                    span_start = length
                elif isinstance(ev, Finished):
                    finished = ev
            retrieval["droppedCitations"] = dropped
            if finished is not None and finished.stop_reason == "refusal":
                # Every model in the fallback chain declined: discard the partial answer.
                status, answer, citations = "refused", [], []
                msg_id = self._save_assistant(conversation_id, "", [], retrieval, finished, status)
                yield "error", {"message": "The assistant declined to answer this request.", "retryable": False, "messageId": msg_id}
                return
            status = "complete"
            msg_id = self._save_assistant(conversation_id, "".join(answer), citations, retrieval, finished, status)
            yield "done", {
                "messageId": msg_id,
                "status": status,
                "stopReason": finished.stop_reason if finished else None,
                "model": finished.model if finished else llm.model,
                "usage": finished.usage if finished else {},
            }
        except GeneratorExit:
            # The reader closed the stream mid-answer: keep what was written.
            self._save_assistant(conversation_id, "".join(answer), citations, retrieval, finished, "interrupted")
            raise
        except LLMError as e:
            msg_id = self._save_assistant(conversation_id, "".join(answer), citations, retrieval, finished, "error")
            yield "error", {"message": str(e), "retryable": e.retryable, "messageId": msg_id}
        except Exception:  # noqa: BLE001 - the stream must end with an event, not a broken connection
            log.exception("chat turn failed in conversation %s", conversation_id)
            msg_id = self._save_assistant(conversation_id, "".join(answer), citations, retrieval, finished, "error")
            yield "error", {"message": "Something went wrong while answering. Try again.", "retryable": True, "messageId": msg_id}

    # Context ----------------------------------------------------------------------------------------

    def _context(self, document_id: str, req: TurnRequest, question: str, history: list[Turn], record: dict[str, Any]) -> Context:
        st = self.settings
        retriever = Retriever(self.db, self.services, st)
        passages: list[Passage] = []

        located = None
        if req.mode in SELECTION_MODES and req.selection:
            located = locate_selection(self.db, document_id, req.selection.text, req.selection.page)
            record["selection"] = {"match": located.match, "chunkId": located.passage.id} if located else None
            if located:
                passages.append(located.passage)
                if req.mode != "ask":
                    passages.extend(self._neighbours(document_id, located.passage))
            else:
                passages.append(_selection_passage(req.selection))

        if req.mode in ("chat", "ask"):
            query = question
            if req.mode == "chat" and history:
                query = self._standalone(history, question)
            elif req.mode == "ask" and req.selection:
                query = f"{question}\n{req.selection.text[:500]}"
            scope = req.scope
            if req.mode == "ask" and located and scope == Scope() and located.passage.section_id:
                scope = Scope(section_id=located.passage.section_id)  # the selection's section by default
            res = retriever.search(
                document_id, query, scope=scope, limit=st.chat_passages, exclude=[p.id for p in passages if p.id]
            )
            passages.extend(h.passage for h in res.hits)
            record.update(
                query=query,
                rewritten=query != question and req.mode == "chat",
                scope={"sectionId": scope.section_id, "pageStart": scope.page_start, "pageEnd": scope.page_end},
                reranked=res.reranked,
                passages=[{"chunkId": h.passage.id, "rank": h.rank, "score": round(h.score, 6)} for h in res.hits],
            )

        ctx = assemble_context(passages, st.context_budget_tokens)
        record["sources"] = [{"n": x.n, "chunkIds": x.chunk_ids, "pageStart": x.page_start, "pageEnd": x.page_end} for x in ctx.sources]
        record["omitted"] = ctx.omitted
        return ctx

    def _standalone(self, history: list[Turn], question: str) -> str:
        """Rewrite a follow-up into a self-contained retrieval query; the original question on failure."""
        try:
            out = self.services.get_llm().complete(
                system=prompts.REWRITE_SYSTEM,
                prompt=prompts.rewrite_prompt(history, question),
                effort=self.settings.llm_aux_effort,
                max_tokens=2048,
            )
        except LLMError as e:
            log.warning("follow-up rewrite failed (%s); searching with the question as asked", e)
            return question
        line = " ".join(out.split())
        return line if 3 <= len(line) <= 1000 else question

    def _neighbours(self, document_id: str, p: Passage) -> list[Passage]:
        """The passages just before and after `p` in the same section: context for explain/summarize/simplify."""
        with self.db.session() as s:
            rows = s.scalars(
                select(Chunk).where(Chunk.document_id == document_id, Chunk.ordinal.in_([p.ordinal - 1, p.ordinal + 1]))
            ).all()
            return [Passage.of(c) for c in rows if c.section_id == p.section_id]

    # Persistence ------------------------------------------------------------------------------------

    def _history(self, conversation_id: str) -> list[Turn]:
        """The last N answered question/answer pairs, oldest first, as plain text."""
        with self.db.session() as s:
            rows = s.scalars(
                select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at.desc()).limit(4 * self.settings.chat_history_turns)
            ).all()
        turns: list[Turn] = []
        for m in reversed(rows):
            if m.role == "user":
                text = m.content
                sel = (m.scope or {}).get("selection")
                if sel and sel.get("text"):
                    text = f"{text}\n\n{prompts.selection_block(sel['text'][:1500])}"
                turns.append(Turn("user", text))
            elif m.status in ANSWERED and m.content.strip():
                turns.append(Turn("assistant", m.content))
        # Keep only complete pairs (a question whose answer failed is dropped), most recent N.
        pairs: list[tuple[Turn, Turn]] = [(a, b) for a, b in zip(turns, turns[1:]) if a.role == "user" and b.role == "assistant"]
        return [t for pair in pairs[-self.settings.chat_history_turns :] for t in pair]

    def _save_user(self, conversation_id: str, content: str, req: TurnRequest) -> str:
        mid = str(uuid.uuid4())
        scope: dict[str, Any] = {k: v for k, v in (("sectionId", req.scope.section_id), ("pageStart", req.scope.page_start), ("pageEnd", req.scope.page_end)) if v is not None}
        if req.selection:
            scope["selection"] = {"text": req.selection.text, "page": req.selection.page}
        with self.db.session() as s:
            s.add(Message(id=mid, conversation_id=conversation_id, role="user", content=content, mode=req.mode, scope=scope, citations=[]))
            conv = s.get(Conversation, conversation_id)
            if conv is not None:
                conv.updated_at = utcnow()
                if not conv.title:
                    conv.title = _title(content, req)
        return mid

    def _save_assistant(
        self, conversation_id: str, content: str, citations: list[dict[str, Any]], retrieval: dict[str, Any], finished: Finished | None, status: str
    ) -> str:
        mid = str(uuid.uuid4())
        with self.db.session() as s:
            s.add(
                Message(
                    id=mid,
                    conversation_id=conversation_id,
                    role="assistant",
                    content=content,
                    mode=retrieval.get("mode", "chat"),
                    scope={},
                    citations=citations,
                    retrieval=retrieval,
                    model=finished.model if finished else None,
                    usage={**(finished.usage if finished else {}), "stopReason": finished.stop_reason if finished else None},
                    status=status,
                )
            )
            conv = s.get(Conversation, conversation_id)
            if conv is not None:
                conv.updated_at = utcnow()
        return mid


# Helpers --------------------------------------------------------------------------------------------


def resolve_citation(ctx: Context, ev: Citation) -> dict[str, Any] | None:
    """Map a model citation (document index + block range) back to a quote, page and rectangles.
    Citations naming a source or block that wasn't provided are dropped (returns None)."""
    src = ctx.source(ev.doc_index + 1)
    if src is None or not (0 <= ev.start_block < len(src.blocks)):
        return None
    end = min(max(ev.end_block, ev.start_block + 1), len(src.blocks))
    cited = src.blocks[ev.start_block : end]
    seen: set[str] = set()
    locations = []
    for b in cited:
        for loc in b.get("locations") or []:
            key = json.dumps(loc, sort_keys=True)
            if key not in seen:
                seen.add(key)
                locations.append(loc)
    quote = " ".join(ev.quote.split()) or " ".join(b["text"] for b in cited)
    return {
        "source": src.n,
        "chunkId": cited[0].get("chunkId") or None,
        "page": locations[0]["page"] if locations else src.page_start,
        "locations": locations,
        "quote": quote,
        "headingPath": src.heading_path,
    }


def _same(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return a["source"] == b["source"] and a["quote"] == b["quote"]


def _source_summary(x: Source) -> dict[str, Any]:
    return {"n": x.n, "headingPath": x.heading_path, "pageStart": x.page_start, "pageEnd": x.page_end, "chunkIds": x.chunk_ids}


def _source_doc(x: Source, doc_title: str) -> SourceDoc:
    blocks = [b["text"] for b in x.blocks if b["text"].strip()] or [x.text]
    title = " > ".join(x.heading_path) or "Untitled section"
    return SourceDoc(title=title, blocks=blocks, context=f"From \"{doc_title}\", {x.pages_label}")


def _selection_passage(sel: Selection) -> Passage:
    """The selection itself, when it can't be matched to an indexed passage (e.g. text in a figure)."""
    page = sel.page or 1
    return Passage(
        id="",
        ordinal=-1,
        section_id=None,
        heading_path=["Selected text"],
        text=sel.text,
        embed_text=sel.text,
        page_start=page,
        page_end=page,
        locations=[],
        token_count=max(1, len(sel.text) // 4),
    )


def _title(content: str, req: TurnRequest) -> str:
    base = content if req.mode in ("chat", "ask") else f"{content}: {req.selection.text if req.selection else ''}"
    base = " ".join(base.split())
    return base if len(base) <= 80 else base[:79].rstrip() + "..."


def suggest_questions(db: Database, services: Services, settings: Settings, document_id: str) -> list[str]:
    """Four starter questions for an empty chat, generated once per document and stored."""
    with db.session() as s:
        doc = s.get(Document, document_id)
        assert doc is not None
        if doc.suggested_questions:
            return list(doc.suggested_questions)
        from ..db import Section

        sections = s.scalars(select(Section).where(Section.document_id == document_id).order_by(Section.ordinal).limit(60)).all()
        outline = [f"{'  ' * (x.level - 1)}{x.title}" for x in sections]
        chunks = s.scalars(select(Chunk).where(Chunk.document_id == document_id).order_by(Chunk.ordinal).limit(40)).all()
        opening, used = [], 0
        for c in chunks:
            if c.heading_path and c.heading_path[0].lower() in ("references", "bibliography"):
                continue
            if used + c.token_count > 2500 and opening:
                break
            opening.append(c.text)
            used += c.token_count
        title = doc.title or doc.file_name
    sources = [SourceDoc(title=f"Outline of \"{title}\"", blocks=["\n".join(outline) or "(no headings found)"]), SourceDoc(title="Opening passages", blocks=opening or ["(no text)"])]
    out = services.get_llm().complete_json(
        system=prompts.SUGGEST_SYSTEM, prompt=prompts.SUGGEST_PROMPT, schema=prompts.Suggestions, sources=sources, effort=settings.llm_aux_effort
    )
    questions = [" ".join(q.split()) for q in out.questions if q.strip()][:4]
    with db.session() as s:
        doc = s.get(Document, document_id)
        if doc is not None:
            doc.suggested_questions = questions
    return questions
