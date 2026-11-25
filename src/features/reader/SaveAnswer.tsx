import { useState } from 'react';
import { BookOpenText, Check, Highlighter, NotebookPen, StickyNote, X } from 'lucide-react';
import { useReader } from './store';
import { flash } from '../../components/ui';
import { cx } from '../../lib/util';
import { locLong, locShort } from '../../lib/locations';
import type { DocumentRecord } from '../../core/types';
import { describeAnswer, saveAsHighlight, saveAsPageNote, saveToJournal, type SavableAnswer, type SavedTo, type SelectionPartLike } from '../../ai/notes';

/**
 * "Save" for an answer (phase 6): a highlight of the selection with the answer as its note (only where the
 * selection's geometry is known, i.e. the selection card), a page note, or a journal entry. Each save can be
 * undone from its confirmation.
 */
export function SaveAnswer({ doc, answer, parts, className }: { doc: DocumentRecord; answer: SavableAnswer; parts?: SelectionPartLike[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<SavedTo[]>([]);
  const [busy, setBusy] = useState(false);
  const ref = (p: number) => locShort(doc, p);

  const save = async (kind: SavedTo) => {
    setBusy(true);
    try {
      const page = useReader.getState().page;
      const r = kind === 'highlight' && parts?.length ? await saveAsHighlight(doc, parts, answer, ref) : kind === 'note' ? await saveAsPageNote(doc, answer, ref, page) : await saveToJournal(doc, answer, ref);
      setSaved((s) => [...s, kind]);
      setOpen(false);
      const where = kind === 'highlight' ? 'Saved as a highlight note' : kind === 'note' ? `Saved as a page note · ${locLong(doc, describeAnswer(answer, ref).page ?? page)}` : 'Saved to your journal';
      flash(where, {
        label: 'Undo',
        run: () =>
          void r.undo().then(
            () => setSaved((s) => s.filter((k) => k !== kind)),
            () => flash('Couldn’t undo that'),
          ),
      });
    } catch (e) {
      flash(`Couldn’t save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const option = (kind: SavedTo, icon: React.ReactNode, label: string, tip: string) => {
    const done = saved.includes(kind);
    return (
      <button
        type="button"
        className={cx('inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-ink-2 transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-50', done && 'text-accent')}
        disabled={busy || done}
        onClick={() => void save(kind)}
        data-tip={done ? 'Saved' : tip}
        data-testid={`save-${kind}`}
      >
        {done ? <Check size={13} /> : icon}
        {label}
      </button>
    );
  };

  if (!open)
    return (
      <button
        type="button"
        className={cx('inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-ink-2 transition-colors hover:bg-ink/5 hover:text-ink', saved.length > 0 && 'text-accent', className)}
        onClick={() => setOpen(true)}
        aria-expanded={false}
        data-testid="save-answer"
      >
        {saved.length ? <Check size={14} /> : <NotebookPen size={14} />}
        {saved.length ? 'Saved' : 'Save'}
      </button>
    );
  return (
    <div className={cx('flex flex-wrap items-center gap-0.5', className)} role="group" aria-label="Save the answer" data-testid="save-options">
      {parts?.length ? option('highlight', <Highlighter size={13} />, 'Highlight + note', 'Highlight the selection, with this answer as its note') : null}
      {option('note', <StickyNote size={13} />, 'Page note', 'A note on the first page the answer cites')}
      {option('journal', <BookOpenText size={13} />, 'Journal', 'A journal entry for today')}
      <button type="button" className="icon-btn h-7 w-7" aria-label="Cancel" onClick={() => setOpen(false)}>
        <X size={13} />
      </button>
    </div>
  );
}
