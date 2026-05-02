/**
 * Density-Mode-Provider.
 *
 * Steuert die UI-Dichte (compact | cozy | comfortable) ueber das
 * `data-density`-Attribut auf <html>. CSS-Variablen in index.css passen
 * Padding/Row-Hoehe/Font-Size der Tabellen entsprechend an.
 *
 * Persistenz: localStorage (User-Preference, ueber Tabs hinweg stabil).
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Density = 'compact' | 'cozy' | 'comfortable';

const KEY = 'ui.density';
const DEFAULT: Density = 'cozy';

interface Ctx {
  density: Density;
  setDensity: (d: Density) => void;
  cycle: () => void;
}

const Context = createContext<Ctx>({
  density: DEFAULT,
  setDensity: () => { /* noop */ },
  cycle: () => { /* noop */ },
});

function read(): Density {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'compact' || v === 'cozy' || v === 'comfortable') return v;
  } catch { /* ignore */ }
  return DEFAULT;
}

export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensityState] = useState<Density>(read);

  // initial sync auf <html>
  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
  }, [density]);

  const setDensity = useCallback((d: Density): void => {
    setDensityState(d);
    try { localStorage.setItem(KEY, d); } catch { /* ignore */ }
  }, []);

  const cycle = useCallback((): void => {
    setDensityState(prev => {
      const next: Density = prev === 'compact' ? 'cozy' : prev === 'cozy' ? 'comfortable' : 'compact';
      try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return <Context.Provider value={{ density, setDensity, cycle }}>{children}</Context.Provider>;
}

export function useDensity(): Ctx {
  return useContext(Context);
}
