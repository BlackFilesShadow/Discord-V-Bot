/**
 * Client-seitiger Bot-Admin-Session-State (analog DevSession).
 *
 * - Speichert NICHTS dauerhaft (kein localStorage). sessionStorage nur als
 *   optimistischer Hint; die Wahrheit kommt vom Server via
 *   GET /api/v2/bot-admin/status.
 * - Login per Passwort (POST /api/v2/bot-admin/login).
 * - Polling alle 30s + bei Window-Focus, damit ablaufende/widerrufene
 *   Sessions zeitnah erkannt werden.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

const SS_HINT = 'botAdminSession.optimistic';

interface BotAdminStatus {
  active: boolean;
  expiresAt: string | null;
}

interface BotAdminSessionState {
  active: boolean;
  expiresAt: string | null;
  loading: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<BotAdminSessionState>({
  active: false, expiresAt: null, loading: true,
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

export function BotAdminSessionProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<boolean>(readHint());
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await api.get<BotAdminStatus>('/api/v2/bot-admin/status');
      setActive(s.active);
      setExpiresAt(s.expiresAt);
      writeHint(s.active);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setActive(false); setExpiresAt(null);
        writeHint(false);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (password: string): Promise<void> => {
    const r = await api.post<{ ok: true; expiresAt: string }>('/api/v2/bot-admin/login', { password });
    setActive(true);
    setExpiresAt(r.expiresAt);
    writeHint(true);
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try { await api.post('/api/v2/bot-admin/logout'); } catch { /* ignore */ }
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
    <Ctx.Provider value={{ active, expiresAt, loading, login, logout, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useBotAdminSession(): BotAdminSessionState {
  return useContext(Ctx);
}
