import { useEffect, useRef, useState } from 'react';
import { subscribe, type StoreName } from './db';

/**
 * Run an async IndexedDB query and re-run it whenever any of `stores` changes
 * (in this tab or another). Returns `undefined` while the first load is pending.
 */
export function useLive<T>(query: () => Promise<T>, stores: StoreName[], deps: unknown[]): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    let alive = true;
    let seq = 0;
    const run = () => {
      const mine = ++seq;
      queryRef.current().then(
        (v) => {
          if (alive && mine === seq) setValue(v);
        },
        (err) => console.error('[folio] live query failed', err),
      );
    };
    run();
    const unsub = subscribe((changed) => {
      if (stores.some((s) => changed.has(s))) run();
    });
    return () => {
      alive = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}
