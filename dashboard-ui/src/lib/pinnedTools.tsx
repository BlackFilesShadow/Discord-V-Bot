/**
 * Pinned-Tools-Provider.
 *
 * User-spezifische Liste der angepinnten DEV-Tool-Slugs (max 8).
 * Persistenz: localStorage. Reihenfolge entspricht Pin-Reihenfolge.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

const KEY = 'dev.pinnedTools';
const MAX = 8;

interface Ctx {
  pinned: ReadonlyArray<string>;
  toggle: (slug: string) => void;
  isPinned: (slug: string) => boolean;
  clear: () => void;
}

const Context = createContext<Ctx>({
  pinned: [],
  toggle: () => { /* noop */ },
  isPinned: () => false,
  clear: () => { /* noop */ },
});

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string').slice(0, MAX);
  } catch { return []; }
}

export function PinnedToolsProvider({ children }: { children: ReactNode }) {
  const [pinned, setPinned] = useState<string[]>(read);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(pinned)); } catch { /* ignore */ }
  }, [pinned]);

  const toggle = useCallback((slug: string): void => {
    setPinned(prev => {
      if (prev.includes(slug)) return prev.filter(s => s !== slug);
      if (prev.length >= MAX) return prev;
      return [...prev, slug];
    });
  }, []);

  const isPinned = useCallback((slug: string): boolean => pinned.includes(slug), [pinned]);

  const clear = useCallback((): void => setPinned([]), []);

  return <Context.Provider value={{ pinned, toggle, isPinned, clear }}>{children}</Context.Provider>;
}

export function usePinnedTools(): Ctx {
  return useContext(Context);
}
