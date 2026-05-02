/**
 * Recent-Actions-Provider (Self-Audit-View).
 *
 * Lokaler Ringbuffer der letzten 25 User-getriggerten Aktionen im
 * Dashboard. Komplett client-seitig (sessionStorage) — der echte
 * Audit-Trail liegt server-seitig in AuditLog (DB).
 *
 * Zweck: Sofortiges visuelles Feedback "was habe ich gerade getan?"
 * fuer Step-up-Workflows und Incident-Response.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export interface RecentAction {
  /** ISO-Timestamp */
  at: string;
  /** Slug oder Bezeichner ("dev.killSwitch", "guild.role.update") */
  kind: string;
  /** Kurzbeschreibung (zeigbar im UI) */
  label: string;
  /** Optional: Severity */
  severity?: 'info' | 'warn' | 'danger';
}

const KEY = 'ui.recentActions';
const MAX = 25;

interface Ctx {
  actions: ReadonlyArray<RecentAction>;
  record: (a: Omit<RecentAction, 'at'>) => void;
  clear: () => void;
}

const Context = createContext<Ctx>({
  actions: [],
  record: () => { /* noop */ },
  clear: () => { /* noop */ },
});

function read(): RecentAction[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is RecentAction =>
      typeof x === 'object' && x !== null
      && typeof (x as RecentAction).at === 'string'
      && typeof (x as RecentAction).kind === 'string'
      && typeof (x as RecentAction).label === 'string',
    ).slice(0, MAX);
  } catch { return []; }
}

export function RecentActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<RecentAction[]>(read);

  useEffect(() => {
    try { sessionStorage.setItem(KEY, JSON.stringify(actions)); } catch { /* ignore */ }
  }, [actions]);

  const record = useCallback((a: Omit<RecentAction, 'at'>): void => {
    const entry: RecentAction = { ...a, at: new Date().toISOString() };
    setActions(prev => [entry, ...prev].slice(0, MAX));
  }, []);

  const clear = useCallback((): void => setActions([]), []);

  return <Context.Provider value={{ actions, record, clear }}>{children}</Context.Provider>;
}

export function useRecentActions(): Ctx {
  return useContext(Context);
}
