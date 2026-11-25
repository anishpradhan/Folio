import type { DocumentRecord } from '../../core/types';
import { cx } from '../../lib/util';

/** A typographic stand-in when a document has no renderable first page. */
function hashHue(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

export function BookCover({ doc, className, eager }: { doc: Pick<DocumentRecord, 'cover' | 'title' | 'author' | 'pageSizes' | 'id'>; className?: string; eager?: boolean }) {
  const [w, h] = doc.pageSizes?.[0] ?? [612, 792];
  const ratio = Math.min(1.6, Math.max(0.6, h / w));
  return (
    <div className={cx('book-cover', className)} style={{ aspectRatio: `1 / ${ratio}` }}>
      {doc.cover ? (
        <img src={doc.cover} alt="" loading={eager ? 'eager' : 'lazy'} draggable={false} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full flex-col justify-between p-[12%]" style={{ background: `hsl(${hashHue(doc.id)} 22% 36%)`, color: '#f6efe2' }}>
          <div className="font-display text-[clamp(13px,1.3vw,18px)] leading-tight">{doc.title}</div>
          <div className="text-[11px] opacity-75">{doc.author}</div>
        </div>
      )}
    </div>
  );
}
