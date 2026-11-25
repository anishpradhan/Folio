import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X } from 'lucide-react';
import { cx, uid } from '../lib/util';

/* ======================= Icon button with tooltip ======================= */

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; active?: boolean };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      data-tip={label}
      data-tip-key={shortcut || undefined}
      aria-pressed={active === undefined ? undefined : active}
      className={cx('icon-btn', className)}
      {...rest}
    >
      {children}
    </button>
  );
});

/* ======================= Global tooltip layer ======================= */

/**
 * One tooltip element for the whole app: any element with `data-tip` gets a tooltip on hover
 * or keyboard focus (with an optional `data-tip-key` shortcut hint). Cheap and consistent.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; key?: string; rect: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const current = useRef<Element | null>(null);

  useEffect(() => {
    const show = (el: Element, immediate: boolean) => {
      clearTimeout(timer.current);
      current.current = el;
      const run = () => {
        if (current.current !== el || !el.isConnected) return;
        const text = el.getAttribute('data-tip');
        if (text) setTip({ text, key: el.getAttribute('data-tip-key') ?? undefined, rect: el.getBoundingClientRect() });
      };
      if (immediate) run();
      else timer.current = setTimeout(run, 450);
    };
    const hide = () => {
      clearTimeout(timer.current);
      current.current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return; // no hover on touch screens
      const el = (e.target as Element)?.closest?.('[data-tip]');
      if (el && el !== current.current) show(el, tip !== null);
      else if (!el && current.current) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = (e.target as Element)?.closest?.('[data-tip]');
      if (el && (e.target as HTMLElement).matches(':focus-visible')) show(el, true);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', hide);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('keydown', hide);
    };
  }, [tip]);

  if (!tip) return null;
  const below = tip.rect.top < 56;
  const left = Math.min(Math.max(tip.rect.left + tip.rect.width / 2, 70), window.innerWidth - 70);
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[100] -translate-x-1/2 anim-pop"
      style={{ left, top: below ? tip.rect.bottom + 8 : tip.rect.top - 8, transform: `translate(-50%, ${below ? '0' : '-100%'})` }}
    >
      <div className="flex items-center gap-2 rounded-lg bg-ink px-2.5 py-1.5 text-[12px] font-medium whitespace-nowrap text-bg shadow-pop">
        {tip.text}
        {tip.key && <span className="rounded bg-bg/15 px-1.5 text-[11px] text-bg/80">{tip.key}</span>}
      </div>
    </div>,
    document.body,
  );
}

/* ======================= Floating panels ======================= */

export type Anchor = DOMRect | { left: number; top: number; width: number; height: number; right?: number; bottom?: number };

interface FloatingProps {
  anchor: Anchor;
  onClose: () => void;
  placement?: 'top' | 'bottom';
  align?: 'center' | 'start' | 'end';
  offset?: number;
  className?: string;
  children: ReactNode;
  /** Elements that count as "inside" for outside-click detection (e.g. the trigger). */
  ignore?: (Element | null)[];
  role?: string;
  label?: string;
  testId?: string;
}

/** Positioned panel in a portal; flips vertically and clamps to the viewport. */
export function Floating({ anchor, onClose, placement = 'bottom', align = 'center', offset = 8, className, children, ignore = [], role = 'dialog', label, testId }: FloatingProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden', left: 0, top: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const w = el.offsetWidth,
        h = el.offsetHeight;
      const vw = window.innerWidth,
        vh = window.innerHeight;
      const bottom = anchor.top + anchor.height;
      let top = placement === 'bottom' ? bottom + offset : anchor.top - h - offset;
      if (placement === 'bottom' && top + h > vh - 8 && anchor.top - h - offset > 8) top = anchor.top - h - offset;
      if (placement === 'top' && top < 8) top = bottom + offset;
      top = Math.max(8, Math.min(top, vh - h - 8));
      let left = align === 'center' ? anchor.left + anchor.width / 2 - w / 2 : align === 'start' ? anchor.left : anchor.left + anchor.width - w;
      left = Math.max(8, Math.min(left, vw - w - 8));
      setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    // Panels whose content grows (a streaming answer) stay on screen.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [anchor.left, anchor.top, anchor.width, anchor.height, placement, align, offset]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (ignore.some((x) => x?.contains(t))) return;
      closeRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    // Defer so the opening click doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('pointerdown', down, true));
    document.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div ref={ref} role={role} aria-label={label} data-testid={testId} className={cx('pop fixed z-50 anim-pop', className)} style={pos}>
      {children}
    </div>,
    document.body,
  );
}

/** Popover attached to a trigger button. */
export function usePopover() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const toggle = useCallback(() => {
    setAnchor((a) => (a ? null : (triggerRef.current?.getBoundingClientRect() ?? null)));
  }, []);
  const close = useCallback(() => setAnchor(null), []);
  return { anchor, open: !!anchor, toggle, close, triggerRef };
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  checked?: boolean;
  hint?: string;
}

export function Menu({ anchor, onClose, items, ignore, align = 'end', title }: { anchor: Anchor; onClose: () => void; items: (MenuItem | 'sep')[]; ignore?: (Element | null)[]; align?: 'start' | 'end' | 'center'; title?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    const btns = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      btns[(i + 1) % btns.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      btns[(i - 1 + btns.length) % btns.length]?.focus();
    }
  };
  return (
    <Floating anchor={anchor} onClose={onClose} align={align} ignore={ignore} role="menu" className="min-w-[210px] p-1.5">
      <div ref={listRef} onKeyDown={onKey}>
        {title && <div className="eyebrow px-2.5 pt-1.5 pb-1">{title}</div>}
        {items.map((it, i) =>
          it === 'sep' ? (
            <div key={i} className="my-1 h-px bg-line" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-ink/5 focus:bg-ink/5 focus:outline-none',
                it.danger ? 'text-danger' : 'text-ink',
              )}
              onClick={() => {
                onClose();
                it.onSelect();
              }}
            >
              {it.icon && <span className="grid w-4 place-items-center text-ink-3">{it.icon}</span>}
              <span className="flex-1">{it.label}</span>
              {it.checked && <span className="text-accent">✓</span>}
              {it.hint && <span className="text-[11px] text-ink-3">{it.hint}</span>}
            </button>
          ),
        )}
      </div>
    </Floating>
  );
}

/* ======================= Dialog ======================= */

export function Dialog({ title, onClose, children, width = 440, footer }: { title: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && ref.current) {
        const f = Array.from(ref.current.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')).filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return;
        const a = f[0],
          z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center p-4 anim-fade" style={{ background: 'color-mix(in srgb, var(--ink) 28%, transparent)' }} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="pop w-full anim-rise" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="font-display text-[19px] font-medium tracking-tight">{title}</h2>
          <IconButton label="Close" data-close onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="px-5 pb-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ======================= Small controls ======================= */

export function Slider({ label, value, min, max, step = 1, onChange, format, id }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string; id?: string }) {
  const p = ((value - min) / (max - min)) * 100;
  const fid = id ?? `s-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <label htmlFor={fid} className="text-ink-2">
          {label}
        </label>
        <span className="tabular-nums text-ink-3">{format ? format(value) : value}</span>
      </div>
      <input id={fid} className="slider" type="range" min={min} max={max} step={step} value={value} style={{ ['--p' as string]: `${p}%` }} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, size = 'md' }: { value: T; options: { value: T; label: ReactNode; tip?: string }[]; onChange: (v: T) => void; label: string; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-ink/[0.05] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          data-tip={o.tip}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-full font-medium transition-all',
            size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[12.5px]',
            value === o.value ? 'bg-surface text-ink shadow-soft' : 'text-ink-3 hover:text-ink-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px] text-ink-2">
      <span>{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cx('relative h-[20px] w-[34px] rounded-full transition-colors', checked ? 'bg-accent' : 'bg-ink/15')}
      >
        <span className={cx('absolute top-[2px] h-4 w-4 rounded-full bg-surface shadow transition-transform', checked ? 'translate-x-[16px]' : 'translate-x-[2px]')} />
      </button>
    </label>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cx('inline-block rounded-full border-2 border-current border-r-transparent opacity-60', className)}
      style={{ width: size, height: size, animation: 'spin 0.8s linear infinite' }}
    />
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-14 text-center anim-rise">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-full bg-accent-soft text-accent">{icon}</div>
      <h3 className="font-display text-[19px] font-medium tracking-tight text-ink">{title}</h3>
      {children && <div className="mt-1.5 text-[13.5px] leading-relaxed text-ink-3">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Auto-growing textarea. */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }>(function AutoTextarea({ minRows = 2, className, value, ...rest }, ref) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
      rows={minRows}
      value={value}
      className={cx('field resize-none leading-relaxed', className)}
      {...rest}
    />
  );
});

/* ======================= Quiet feedback ======================= */

interface FeedbackItem {
  id: string;
  message: string;
  action?: { label: string; run: () => void };
}

export const useFeedback = create<{ items: FeedbackItem[]; flash: (message: string, action?: FeedbackItem['action'], ms?: number) => void; dismiss: (id: string) => void }>((set, get) => ({
  items: [],
  flash: (message, action, ms = action ? 6000 : 1800) => {
    const id = uid();
    set({ items: [...get().items.slice(-1), { id, message, action }] });
    setTimeout(() => get().dismiss(id), ms);
  },
  dismiss: (id) => set({ items: get().items.filter((i) => i.id !== id) }),
}));

export const flash = (message: string, action?: FeedbackItem['action'], ms?: number) => useFeedback.getState().flash(message, action, ms);

export function FeedbackLayer() {
  const items = useFeedback((s) => s.items);
  const dismiss = useFeedback((s) => s.dismiss);
  return createPortal(
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[90] flex flex-col items-center gap-2">
      {items.map((i) => (
        <div key={i.id} className="pointer-events-auto flex items-center gap-3 rounded-full bg-ink py-2 pr-2 pl-4 text-[13px] text-bg shadow-pop anim-rise">
          <span>{i.message}</span>
          {i.action ? (
            <button
              className="rounded-full bg-bg/15 px-3 py-1 text-[12px] font-semibold text-bg hover:bg-bg/25"
              onClick={() => {
                i.action!.run();
                dismiss(i.id);
              }}
            >
              {i.action.label}
            </button>
          ) : (
            <span className="w-2" />
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
