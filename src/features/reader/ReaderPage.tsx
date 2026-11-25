import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FileWarning } from 'lucide-react';
import { useLive } from '../../data/useLive';
import { getDocument, getFileBlob, listBookmarks, listHighlights, latestPosition, listNotes, updateDocument } from '../../data/repo';
import { loadPdf, isPasswordError, type PDFDocumentProxy } from '../../core/pdf/pdfjs';
import type { EpubBook } from '../../core/epub/book';
import { navigate } from '../../lib/router';
import { usePrefs } from '../../state/prefs';
import { cx } from '../../lib/util';
import { EmptyState } from '../../components/ui';
import { useReader } from './store';
import { Viewer } from './Viewer';
import { Toolbar } from './Toolbar';
import { BottomBar } from './BottomBar';
import { LeftSidebar } from './LeftSidebar';
import { RightSidebar } from './RightSidebar';
import { ReaderPopovers } from './Popovers';
import { PreferencesPanel } from './PreferencesPanel';
import { usePositionPersistence, useReaderShortcuts, useReadingActivity } from './hooks';
import { BookCover } from '../library/BookCover';

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; title: string; message: string };

function useMediaQuery(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

export default function ReaderPage({ docId, initialPage, focusHighlight }: { docId: string; initialPage?: number; focusHighlight?: string }) {
  const docRecord = useLive(() => getDocument(docId), ['documents'], [docId]);
  const highlights = useLive(() => listHighlights(docId), ['highlights'], [docId]);
  const bookmarks = useLive(() => listBookmarks(docId), ['bookmarks'], [docId]);
  const notes = useLive(() => listNotes(docId), ['notes'], [docId]);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const set = useReader((s) => s.set);
  const reset = useReader((s) => s.reset);
  const focus = useReader((s) => s.focus);
  const leftOpen = usePrefs((s) => s.leftOpen);
  const rightOpen = usePrefs((s) => s.rightOpen);
  const setPrefs = usePrefs((s) => s.set);
  const appearance = usePrefs((s) => s.appearance);
  const wide = useMediaQuery('(min-width: 1100px)');

  // Keep the reader store in sync with persisted data.
  useEffect(() => {
    if (docRecord) set({ doc: docRecord });
  }, [docRecord, set]);
  useEffect(() => void (highlights && set({ highlights })), [highlights, set]);
  useEffect(() => void (bookmarks && set({ bookmarks })), [bookmarks, set]);
  useEffect(() => void (notes && set({ notes })), [notes, set]);

  // Open the PDF once the record is known (re-runs safely under StrictMode).
  const recordRef = useRef(docRecord);
  recordRef.current = docRecord;
  const known = docRecord !== undefined;
  useEffect(() => {
    if (!known) return;
    const docRecord = recordRef.current;
    if (!docRecord || docRecord.deletedAt) {
      setLoad({ status: 'error', title: 'This book is no longer on your shelf', message: 'It may have been removed. Head back to your library to pick another.' });
      return;
    }
    let pdf: PDFDocumentProxy | null = null;
    let book: EpubBook | null = null;
    let cancelled = false;
    (async () => {
      const blob = await getFileBlob(docId);
      if (!blob) throw new Error('missing');
      if (docRecord.format === 'epub') {
        const { openEpub } = await import('../../core/epub/book');
        book = openEpub(new Uint8Array(await blob.arrayBuffer()));
        if (cancelled) return book.destroy();
      } else {
        pdf = await loadPdf(await blob.arrayBuffer());
        if (cancelled) return pdf.destroy();
      }
      // Restore the reading environment: page, offset, zoom, layout and view.
      const prefs = usePrefs.getState();
      const pos = latestPosition(docId, docRecord.position);
      const target = focusHighlight ? (await listHighlights(docId)).find((h) => h.id === focusHighlight) : undefined;
      const page = Math.min(docRecord.pageCount, Math.max(1, target?.page ?? initialPage ?? pos?.page ?? 1));
      set({
        pdf,
        book,
        doc: docRecord,
        page,
        offset: target ? Math.max(0, (target.rects[0]?.y ?? 0) - 0.05) : initialPage ? 0 : (pos?.offset ?? 0),
        scale: pos?.scale ?? 1.3,
        zoomMode: pos?.zoomMode ?? prefs.defaultZoom,
        layout: pos?.layout ?? prefs.defaultLayout,
        view: pos?.view ?? 'original',
        flashHighlight: target?.id ?? null,
      });
      if (target) setTimeout(() => useReader.getState().set({ flashHighlight: null }), 3600);
      void updateDocument(docId, { lastOpenedAt: Date.now() });
      setLoad({ status: 'ready' });
    })().catch((e) => {
      if (cancelled) return;
      console.error(e);
      setLoad(
        isPasswordError(e)
          ? { status: 'error', title: 'This PDF is password-protected', message: 'Folio cannot open encrypted documents yet.' }
          : { status: 'error', title: "This document couldn't be opened", message: 'The file may be damaged. Try removing it and adding it again.' },
      );
    });
    return () => {
      cancelled = true;
      void pdf?.destroy();
      book?.destroy();
    };
  }, [known, docId, initialPage, focusHighlight, set]);

  // Clear reader state on leave (the PDF itself is destroyed by the loader's cleanup).
  useEffect(() => () => reset(), [reset]);

  const ready = load.status === 'ready';
  usePositionPersistence(ready);
  useReaderShortcuts(ready);
  const elapsed = useReadingActivity(ready ? docId : null);

  useEffect(() => {
    if (docRecord?.title) document.title = `${docRecord.title} · Folio`;
    return () => {
      document.title = 'Folio';
    };
  }, [docRecord?.title]);

  // On narrow screens the sidebars overlay the page: start with the page visible, and keep at
  // most one panel open — the one opened most recently wins.
  const prevPanels = useRef({ leftOpen, rightOpen });
  useEffect(() => {
    if (!window.matchMedia('(min-width: 1100px)').matches) setPrefs({ leftOpen: false, rightOpen: false });
  }, [setPrefs]);
  useEffect(() => {
    const prev = prevPanels.current;
    prevPanels.current = { leftOpen, rightOpen };
    if (wide || !leftOpen || !rightOpen) return;
    if (!prev.rightOpen) setPrefs({ leftOpen: false });
    else setPrefs({ rightOpen: false });
  }, [wide, leftOpen, rightOpen, setPrefs]);

  const stageStyle = useMemo(() => {
    const a = appearance;
    // Invert first (hue-preserving), then tune — so brightness/contrast act on the dark page itself.
    const filter = [a.invert ? 'invert(0.9) hue-rotate(180deg)' : '', `brightness(${a.brightness}%)`, `contrast(${a.contrast}%)`, a.sepia ? `sepia(${a.sepia}%)` : ''].filter(Boolean).join(' ');
    return {
      '--stage-bg': a.surround === 'auto' ? undefined : a.surround,
      '--page-filter': filter,
      '--warmth': (a.warmth / 100) * 0.32,
      '--shadow-k': a.shadow / 100,
      '--hl-blend': a.invert ? 'screen' : 'multiply',
      '--hl-opacity': a.invert ? 0.36 : 0.5,
    } as React.CSSProperties;
  }, [appearance]);

  if (load.status === 'error')
    return (
      <div className="grid h-full place-items-center bg-bg">
        <EmptyState
          icon={<FileWarning size={22} />}
          title={load.title}
          action={
            <button className="btn btn-primary" onClick={() => navigate('/')}>
              <ArrowLeft size={15} /> Back to library
            </button>
          }
        >
          {load.message}
        </EmptyState>
      </div>
    );

  if (!ready || !docRecord)
    return (
      <div className="grid h-full place-items-center bg-bg" aria-busy="true">
        <div className="flex flex-col items-center gap-5 anim-fade">
          {docRecord && <BookCover doc={docRecord} className="w-[120px] animate-pulse" eager />}
          <div className="text-center">
            <div className="font-display text-[18px]">{docRecord?.title ?? 'Opening…'}</div>
            <div className="mt-1 text-[12.5px] text-ink-3">Opening your book…</div>
          </div>
        </div>
      </div>
    );

  const overlaySidebars = !wide;
  return (
    <div className={cx('flex h-full flex-col overflow-hidden anim-open', appearance.invert && 'inverted')} data-testid="reader">
      <Toolbar elapsed={elapsed} />
      <div className="relative flex min-h-0 flex-1">
        <LeftSidebar overlay={overlaySidebars} />
        <main
          className={cx('reader-stage relative min-w-0 flex-1', `tex-${appearance.texture}`, appearance.invert && '[&_.pdf-page]:!bg-[#1c1b19]')}
          style={stageStyle}
          aria-label="Document"
        >
          <Viewer />
        </main>
        <RightSidebar overlay={overlaySidebars} />
        {overlaySidebars && (leftOpen || rightOpen) && !focus && (
          <button aria-label="Close panel" className="absolute inset-0 z-20 bg-black/10 anim-fade" onClick={() => setPrefs({ leftOpen: false, rightOpen: false })} />
        )}
      </div>
      <BottomBar />
      <ReaderPopovers />
      <PreferencesPanel />
    </div>
  );
}
