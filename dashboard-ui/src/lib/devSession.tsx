/**
 * Client-seitiger DEV-Session-State.
 *
 * - Speichert NICHTS im localStorage (Spec 3: keine Persistenz ueber Tab hinaus).
 * - sessionStorage wird nur als optimistischer Hint genutzt; die echte
 *   Wahrheit kommt vom Server via GET /api/v2/dev/status (Spec 3:
 *   serverseitige Sessionpruefung).
 * - Beim Window-Schliessen leert der Browser sessionStorage automatisch;
 *   serverseitig ist die DevSession ohnehin zeit- und revoke-gesteuert.
 * - Polling alle 30s + bei Window-Focus, damit ablaufende/widerrufene
 *   Sessions zeitnah erkannt werden.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

const SS_HINT = 'devSession.optimistic';

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

function readHint(): boolean {
  try { return sessionStorage.getItem(SS_HINT) === '1'; } catch { return false; }
}
function writeHint(v: boolean): void {
  try {
    if (v) sessionStorage.setItem(SS_HINT, '1');
    else sessionStorage.removeItem(SS_HINT);
  } catch { /* ignore */ }
}

export function DevSessionProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<boolean>(readHint());
  const [eligible, setEligible] = useState<boolean>(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await api.get<DevStatus>('/api/v2/dev/status');
      setActive(s.active);
      setEligible(s.eligible);
      setExpiresAt(s.expiresAt);
      writeHint(s.active);
    } catch (e) {
      // 401 = nicht eingeloggt — DevSession trivialerweise inaktiv.
      if (e instanceof ApiError && e.status === 401) {
        setActive(false); setEligible(false); setExpiresAt(null);
        writeHint(false);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (password: string): Promise<void> => {
    const r = await api.post<{ ok: true; expiresAt: string }>('/api/v2/dev/login', { password });
    setActive(true);
    setEligible(true);
    setExpiresAt(r.expiresAt);
    writeHint(true);
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try { await api.post('/api/v2/dev/logout'); } catch { /* ignore */ }
    setActive(false);
    setExpiresAt(null);
    writeHint(false);
  }, []);

  useEffect(() => {
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
