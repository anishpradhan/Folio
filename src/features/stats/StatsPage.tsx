import { useMemo, useState } from 'react';
import { Flame, Plus, Target, Trash2, BookOpen, Clock, CheckCircle2 } from 'lucide-react';
import { useLive } from '../../data/useLive';
import { addGoal, deleteGoal, listDays, listDocuments, listGoals } from '../../data/repo';
import type { DocumentRecord, Goal, GoalKind, ReadingDay } from '../../core/types';
import { addDays, cx, dayKey, formatDate, formatDuration, parseDayKey } from '../../lib/util';
import { Dialog, EmptyState, Spinner } from '../../components/ui';
import { BookCover } from '../library/BookCover';
import { navigate, readerPath } from '../../lib/router';
import { progressOf } from '../library/LibraryPage';

const pagesOn = (d?: ReadingDay) => (d ? Object.values(d.pages).reduce((n, p) => n + p.length, 0) : 0);
const active = (d?: ReadingDay) => !!d && (d.ms >= 60_000 || pagesOn(d) > 0);

export function computeStreak(byDate: Map<string, ReadingDay>, today = dayKey()) {
  let day = active(byDate.get(today)) ? today : addDays(today, -1);
  let n = 0;
  while (active(byDate.get(day))) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

function bestStreak(days: ReadingDay[]) {
  let best = 0,
    run = 0,
    prev: string | null = null;
  for (const d of days.filter(active)) {
    run = prev && addDays(prev, 1) === d.date ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d.date;
  }
  return best;
}

/* ------------------------------ figures ------------------------------ */

function Figure({ value, label, sub }: { value: string | number; label: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="font-display text-[34px] leading-none font-medium tracking-tight tabular-nums">{value}</div>
      <div className="mt-2 text-[12.5px] text-ink-2">{label}</div>
      {sub && <div className="text-[11.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

/** 16-week reading calendar: one hue, opacity steps by minutes read. */
function Calendar({ byDate }: { byDate: Map<string, ReadingDay> }) {
  const weeks = 16;
  const today = parseDayKey(dayKey());
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay())); // end of this week (Sat)
  const start = new Date(end);
  start.setDate(start.getDate() - weeks * 7 + 1);
  const cols: { key: string; ms: number; pages: number; future: boolean }[][] = [];
  const d = new Date(start);
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const key = dayKey(d);
      const rec = byDate.get(key);
      col.push({ key, ms: rec?.ms ?? 0, pages: pagesOn(rec), future: d > today });
      d.setDate(d.getDate() + 1);
    }
    cols.push(col);
  }
  const level = (ms: number, pages: number) => (ms <= 0 && !pages ? 0 : ms < 10 * 60e3 ? 1 : ms < 25 * 60e3 ? 2 : ms < 50 * 60e3 ? 3 : 4);
  const alpha = [0, 0.28, 0.5, 0.74, 1];
  return (
    <figure>
      <div className="flex gap-[3px]" role="img" aria-label="Reading calendar for the last 16 weeks">
        {cols.map((col, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            {col.map((c) => {
              const l = level(c.ms, c.pages);
              return (
                <div
                  key={c.key}
                  data-tip={c.future ? undefined : `${formatDate(c.key, { weekday: 'short', day: 'numeric', month: 'short' })} · ${c.ms ? formatDuration(c.ms) : 'no reading'}${c.pages ? ` · ${c.pages} pages` : ''}`}
                  className="h-[13px] w-[13px] rounded-[3px] sm:h-[15px] sm:w-[15px]"
                  style={{ background: c.future ? 'transparent' : l ? `color-mix(in srgb, var(--accent) ${alpha[l] * 100}%, var(--bg-2))` : 'var(--bg-2)' }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <figcaption className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-3">
        Less
        {alpha.map((a, i) => (
          <span key={i} className="h-[10px] w-[10px] rounded-[2px]" style={{ background: i ? `color-mix(in srgb, var(--accent) ${a * 100}%, var(--bg-2))` : 'var(--bg-2)' }} />
        ))}
        More
      </figcaption>
    </figure>
  );
}

/** Minutes per day for the last 14 days — thin bars anchored to the baseline, hover for values. */
function DailyBars({ byDate }: { byDate: Map<string, ReadingDay> }) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(dayKey(), i - 13));
  const mins = days.map((k) => Math.round((byDate.get(k)?.ms ?? 0) / 60000));
  const max = Math.max(10, ...mins);
  const H = 120;
  return (
    <figure>
      <div className="flex h-[140px] items-end gap-[2px] border-b border-line" role="img" aria-label="Minutes read per day, last 14 days">
        {days.map((k, i) => (
          <div key={k} className="group flex h-full flex-1 flex-col items-center justify-end" data-tip={`${formatDate(k, { weekday: 'short', day: 'numeric', month: 'short' })} · ${mins[i]} min`}>
            <div className={cx('w-full max-w-[18px] rounded-t-[4px] transition-colors', mins[i] ? 'bg-accent/80 group-hover:bg-accent' : 'bg-transparent')} style={{ height: mins[i] ? Math.max(3, (mins[i] / max) * H) : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-ink-3">
        <span>{formatDate(days[0], { day: 'numeric', month: 'short' })}</span>
        <span>Today</span>
      </div>
      <table className="sr-only">
        <caption>Minutes read per day</caption>
        <tbody>
          {days.map((k, i) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{mins[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/* ------------------------------ goals ------------------------------ */

function ProgressLine({ value }: { value: number }) {
  return (
    <div className="h-[5px] overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.min(1, value) * 100}%` }} />
    </div>
  );
}

function GoalCard({ goal, byDate, docs }: { goal: Goal; byDate: Map<string, ReadingDay>; docs: Map<string, DocumentRecord> }) {
  const today = byDate.get(dayKey());
  const week = Array.from({ length: 7 }, (_, i) => addDays(dayKey(), i - 6));
  let title = '',
    value = 0,
    detail = '',
    met: boolean[] = [];
  if (goal.kind === 'pages-daily') {
    const n = pagesOn(today);
    title = `Read ${goal.target} pages a day`;
    value = n / goal.target;
    detail = `${n} of ${goal.target} pages today`;
    met = week.map((k) => pagesOn(byDate.get(k)) >= goal.target);
  } else if (goal.kind === 'minutes-daily') {
    const m = Math.floor((today?.ms ?? 0) / 60000);
    title = `Read for ${goal.target} minutes a day`;
    value = m / goal.target;
    detail = `${m} of ${goal.target} minutes today`;
    met = week.map((k) => (byDate.get(k)?.ms ?? 0) / 60000 >= goal.target);
  } else {
    const d = goal.docId ? docs.get(goal.docId) : undefined;
    title = d ? `Finish “${d.title}”` : 'Finish a book (removed)';
    const pct = d ? progressOf(d) / 100 : 0;
    value = pct;
    if (d && goal.deadline) {
      const daysLeft = Math.max(0, Math.round((parseDayKey(goal.deadline).getTime() - parseDayKey(dayKey()).getTime()) / 86400000));
      const pagesLeft = Math.max(0, d.pageCount - d.furthestPage);
      detail = d.completedAt ? 'Finished — well done.' : `${pagesLeft} pages left · ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} to go${daysLeft ? ` · about ${Math.ceil(pagesLeft / daysLeft)} pages/day` : ''}`;
    } else detail = `${Math.round(pct * 100)}% read`;
  }
  const done = value >= 1;
  return (
    <li className="group py-5" data-testid="goal">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="flex items-center gap-2 font-serif text-[16px] text-ink">
          {done && <CheckCircle2 size={16} className="text-accent" />}
          {title}
        </h3>
        <button className="icon-btn h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="Remove goal" data-tip="Remove goal" onClick={() => void deleteGoal(goal.id)}>
          <Trash2 size={14} />
        </button>
      </div>
      <ProgressLine value={value} />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-3">
        <span>{detail}</span>
        {met.length > 0 && (
          <span className="flex items-center gap-1" aria-label="Last 7 days">
            {met.map((m, i) => (
              <span key={i} data-tip={`${formatDate(week[i], { weekday: 'short', day: 'numeric' })}${m ? ' · goal met' : ''}`} className={cx('h-2 w-2 rounded-full', m ? 'bg-accent' : 'bg-ink/12')} style={m ? undefined : { background: 'color-mix(in srgb, var(--ink) 12%, transparent)' }} />
            ))}
          </span>
        )}
      </div>
    </li>
  );
}

function NewGoal({ docs, onClose }: { docs: DocumentRecord[]; onClose: () => void }) {
  const [kind, setKind] = useState<GoalKind>('pages-daily');
  const [target, setTarget] = useState(20);
  const unfinished = docs.filter((d) => !d.completedAt);
  const [docId, setDocId] = useState(unfinished[0]?.id ?? '');
  const [deadline, setDeadline] = useState(addDays(dayKey(), 30));
  const valid = kind === 'finish-doc' ? !!docId && !!deadline : target > 0;
  const save = async () => {
    if (!valid) return;
    await addGoal(kind, kind === 'finish-doc' ? 1 : target, kind === 'finish-doc' ? docId : null, kind === 'finish-doc' ? deadline : null);
    onClose();
  };
  return (
    <Dialog
      title="Set a reading goal"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => void save()}>
            Set goal
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-2" role="radiogroup" aria-label="Goal type">
          {(
            [
              ['pages-daily', 'Pages each day', 'e.g. read 20 pages per day'],
              ['minutes-daily', 'Minutes each day', 'e.g. read for 30 minutes daily'],
              ['finish-doc', 'Finish a book by a date', 'e.g. finish within a month'],
            ] as const
          ).map(([k, label, hint]) => (
            <button key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={cx('rounded-xl px-4 py-3 text-left transition-colors', kind === k ? 'bg-accent/10 ring-1 ring-accent/40' : 'bg-ink/[0.03] hover:bg-ink/[0.06]')}>
              <div className="text-[13.5px] font-medium">{label}</div>
              <div className="text-[12px] text-ink-3">{hint}</div>
            </button>
          ))}
        </div>
        {kind === 'finish-doc' ? (
          <>
            <label className="grid gap-1.5 text-[12.5px] text-ink-2">
              Book
              <select className="field" value={docId} onChange={(e) => setDocId(e.target.value)}>
                {unfinished.length ? (
                  unfinished.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))
                ) : (
                  <option value="">No unfinished books</option>
                )}
              </select>
            </label>
            <label className="grid gap-1.5 text-[12.5px] text-ink-2">
              Finish by
              <input className="field" type="date" min={dayKey()} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
          </>
        ) : (
          <label className="grid gap-1.5 text-[12.5px] text-ink-2">
            {kind === 'pages-daily' ? 'Pages per day' : 'Minutes per day'}
            <input className="field" type="number" min={1} max={1000} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
          </label>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------ page ------------------------------ */

export default function StatsPage() {
  const days = useLive(listDays, ['days'], []);
  const docsList = useLive(listDocuments, ['documents'], []);
  const goals = useLive(listGoals, ['goals'], []);
  const [adding, setAdding] = useState(false);

  const byDate = useMemo(() => new Map((days ?? []).map((d) => [d.date, d])), [days]);
  const docs = useMemo(() => new Map((docsList ?? []).map((d) => [d.id, d])), [docsList]);

  if (!days || !docsList || !goals)
    return (
      <div className="grid h-60 place-items-center text-ink-3">
        <Spinner />
      </div>
    );

  const totalMs = days.reduce((n, d) => n + d.ms, 0);
  const totalPages = days.reduce((n, d) => n + pagesOn(d), 0);
  const completed = docsList.filter((d) => d.completedAt).sort((a, b) => b.completedAt! - a.completedAt!);
  const reading = docsList.filter((d) => d.lastOpenedAt && !d.completedAt);
  const streak = computeStreak(byDate);
  const best = bestStreak(days);
  const activeDays = days.filter(active).length;

  return (
    <div className="mx-auto max-w-[1000px] px-5 pt-8 pb-16 sm:px-10 md:pt-12">
      <header className="mb-10">
        <p className="eyebrow mb-2">Your reading life</p>
        <h1 className="font-display text-[32px] leading-tight font-medium tracking-tight">{totalMs > 0 ? `${formatDuration(totalMs)} spent reading.` : 'A fresh start.'}</h1>
        <p className="mt-1.5 font-serif text-[15px] text-ink-2 italic">
          {activeDays > 0 ? `Across ${activeDays} ${activeDays === 1 ? 'day' : 'days'} of reading. ` : 'Open a book and Folio will quietly keep track of your time and pages. '}
          {streak > 1 ? `You’re on a ${streak}-day streak.` : ''}
        </p>
      </header>

      <section className="mb-14 grid grid-cols-2 gap-x-6 gap-y-8 border-y border-line py-8 sm:grid-cols-3 lg:grid-cols-6" aria-label="Totals">
        <Figure value={docsList.length} label="Documents" />
        <Figure value={reading.length} label="Reading now" />
        <Figure value={completed.length} label="Completed" />
        <Figure value={totalPages} label="Pages read" />
        <Figure value={formatDuration(totalMs)} label="Reading time" />
        <Figure value={streak} label={streak === 1 ? 'Day streak' : 'Day streak'} sub={best > streak ? `Best: ${best} days` : undefined} />
      </section>

      <div className="mb-14 grid gap-12 lg:grid-cols-[auto_1fr]">
        <section>
          <h2 className="mb-4 flex items-center gap-2 font-display text-[18px] font-medium">
            <Flame size={16} className="text-accent" /> Reading days
          </h2>
          <Calendar byDate={byDate} />
        </section>
        <section className="min-w-0">
          <h2 className="mb-4 flex items-center gap-2 font-display text-[18px] font-medium">
            <Clock size={16} className="text-accent" /> Minutes per day
          </h2>
          <DailyBars byDate={byDate} />
        </section>
      </div>

      <section className="mb-14">
        <div className="mb-2 flex items-center justify-between border-b border-line pb-3">
          <h2 className="flex items-center gap-2 font-display text-[18px] font-medium">
            <Target size={16} className="text-accent" /> Goals
          </h2>
          <button className="btn btn-outline h-8" onClick={() => setAdding(true)} data-testid="goal-new">
            <Plus size={14} /> New goal
          </button>
        </div>
        {goals.length ? (
          <ul className="divide-y divide-line">
            {goals.map((g) => (
              <GoalCard key={g.id} goal={g} byDate={byDate} docs={docs} />
            ))}
          </ul>
        ) : (
          <p className="py-6 text-[13.5px] text-ink-3">No goals yet. A small daily habit — ten pages, twenty minutes — adds up to many books a year.</p>
        )}
      </section>

      <section>
        <h2 className="mb-5 flex items-center gap-2 border-b border-line pb-3 font-display text-[18px] font-medium">
          <BookOpen size={16} className="text-accent" /> Recently completed
        </h2>
        {completed.length ? (
          <div className="flex flex-wrap gap-8">
            {completed.slice(0, 8).map((d) => (
              <button key={d.id} className="book w-[110px] text-left" onClick={() => navigate(readerPath(d.id))}>
                <BookCover doc={d} />
                <div className="mt-2.5 line-clamp-2 font-serif text-[13px] leading-snug">{d.title}</div>
                <div className="text-[11.5px] text-ink-3">{formatDate(d.completedAt!)}</div>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState icon={<BookOpen size={20} />} title="No finished books yet">
            Reach the last page of a document and it will be shelved here.
          </EmptyState>
        )}
      </section>

      {adding && <NewGoal docs={docsList} onClose={() => setAdding(false)} />}
    </div>
  );
}
