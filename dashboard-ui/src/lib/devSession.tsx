/**
 * Client-seitiger DEV-Session-State.
 *
 * - Speichert keinen privilegierten Active-State in localStorage/sessionStorage.
 * - Die Wahrheit kommt ausschliesslich vom Server via GET /api/v2/dev/status.
 * - Ein historischer `devSession.optimistic`-Hint wird nur noch bereinigt und
 *   kann niemals DEV-UI oder Tool-Reads freischalten.
 * - Polling alle 30s + bei Window-Focus, damit ablaufende/widerrufene
 *   Sessions zeitnah erkannt werden.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

const LEGACY_SS_HINT = 'devSession.optimistic';

interface DevStatus {
  active: boolean;
  eligible: boolean;
  expiresAt: string | null;
}

interface DevSessionState {
  active: boolean;
  eligible: boolean;
  expiresAt: string | null;
  loading: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<DevSessionState>({
  active: false, eligible: false, expiresAt: null, loading: true,
  login: async () => { /* noop */ },
  logout: async () => { /* noop */ },
  refresh: async () => { /* noop */ },
});

function clearLegacyHint(): void {
  try { sessionStorage.removeItem(LEGACY_SS_HINT); } catch { /* ignore */ }
}

export function DevSessionProvider({ children }: { children: ReactNode }) {
  // Privilegierter Zustand startet immer fail-closed. Auch ein alter Browser-Hint
  // darf vor der ersten Server-Antwort niemals als aktive Session gelten.
  const [active, setActive] = useState<boolean>(false);
  const [eligible, setEligible] = useState<boolean>(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await api.get<DevStatus>('/api/v2/dev/status');
      setActive(s.active);
      setEligible(s.eligible);
      setExpiresAt(s.expiresAt);
      clearLegacyHint();
    } catch {
      // Privilegierte UI muss bei jeder fehlgeschlagenen Server-Bestaetigung
      // fail-closed werden. 403/5xx und Netzfehler lassen keinen stale Active-
      // Zustand weiterleben.
      setActive(false);
      setEligible(false);
      setExpiresAt(null);
      clearLegacyHint();
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (password: string): Promise<void> => {
    const r = await api.post<{ ok: true; expiresAt: string }>('/api/v2/dev/login', { password });
    setActive(true);
    setEligible(true);
    setExpiresAt(r.expiresAt);
    clearLegacyHint();
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try { await api.post('/api/v2/dev/logout'); } catch { /* ignore */ }
    setActive(false);
    setExpiresAt(null);
    clearLegacyHint();
  }, []);

  useEffect(() => {
    clearLegacyHint();
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, 30_000);
    const onFocus = (): void => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return (
    <Ctx.Provider value={{ active, eligible, expiresAt, loading, login, logout, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useDevSession(): DevSessionState {
  return useContext(Ctx);
}
