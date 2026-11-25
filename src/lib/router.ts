import { useEffect, useState } from 'react';

export type Route =
  | { name: 'library'; collection?: string }
  | { name: 'read'; id: string; page?: number; highlight?: string }
  | { name: 'insights' }
  | { name: 'vocabulary' }
  | { name: 'journal' }
  | { name: 'stats' };

export function parseHash(hash: string): Route {
  const [path, qs = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(qs);
  const parts = path.split('/').filter(Boolean);
  switch (parts[0]) {
    case 'read':
      if (parts[1])
        return {
          name: 'read',
          id: decodeURIComponent(parts[1]),
          page: params.get('page') ? Number(params.get('page')) : undefined,
          highlight: params.get('hl') ?? undefined,
        };
      break;
    case 'insights':
      return { name: 'insights' };
    case 'vocabulary':
      return { name: 'vocabulary' };
    case 'journal':
      return { name: 'journal' };
    case 'stats':
      return { name: 'stats' };
    case 'collection':
      if (parts[1]) return { name: 'library', collection: decodeURIComponent(parts[1]) };
  }
  return { name: 'library' };
}

export function navigate(path: string) {
  const next = path.startsWith('#') ? path : `#${path}`;
  if (location.hash !== next) location.hash = next;
}

export const readerPath = (id: string, page?: number, highlight?: string) => {
  const q = new URLSearchParams();
  if (page) q.set('page', String(page));
  if (highlight) q.set('hl', highlight);
  const s = q.toString();
  return `/read/${encodeURIComponent(id)}${s ? `?${s}` : ''}`;
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
