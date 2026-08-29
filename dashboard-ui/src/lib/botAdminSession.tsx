/**
 * Client-seitiger Bot-Admin-Zugriffsstatus.
 *
 * - Speichert NICHTS dauerhaft (kein localStorage). sessionStorage ist nur ein
 *   optimistischer Hint; die Wahrheit kommt immer vom Server.
 * - Primaerer Pfad: BotAdminSession via /api/v2/bot-admin/status.
 * - DEV-Fallback: eine bereits aktive DEV-Session darf Bot-Admin nutzen, ohne
 *   ein zweites Bot-Admin-Passwort einzugeben. Die eigentliche Autorisierung
 *   bleibt serverseitig in requireBotAdmin/requireDev erzwungen.
 * - Polling alle 30s + bei Window-Focus, damit ablaufende/widerrufene Sessions
 *   zeitnah erkannt werden.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

const SS_HINT = 'botAdminSession.optimistic';
// Ein Strict-Mode-Remount darf eine noch offene Statusantwort ebenfalls nicht
// wieder gueltig machen. Das Modul lebt pro Browser-Tab genau einmal und ist
// daher die passende Grenze fuer diese Session-Generationen.
let statusRequestGeneration = 0;
let verifiedSessionEpoch = 0;

export type BotAdminAccessSource = 'bot-admin' | 'dev' | null;

interface BotAdminStatus {
  active: boolean;
  expiresAt: string | null;
}

interface DevStatus {
  active: boolean;
  eligible: boolean;
  expiresAt?: string | null;
}

interface BotAdminSessionState {
  active: boolean;
  expiresAt: string | null;
  source: BotAdminAccessSource;
  loading: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<BotAdminSessionState>({
  active: false, expiresAt: null, source: null, loading: true,
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
  const [source, setSource] = useState<BotAdminAccessSource>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // Status-Antworten koennen sich überlappen (Initial-Load, Window-Focus,
  // Polling und Login-Bestaetigung). Nur die juengste darf den UI-Zustand
  // setzen; sonst kann eine alte "inaktiv"-Antwort eine neue Session sofort
  // wieder verdecken.

  const applyStatus = useCallback((status: BotAdminStatus, nextSource: BotAdminAccessSource): void => {
    setActive(status.active);
    setExpiresAt(status.expiresAt);
    setSource(status.active ? nextSource : null);
    writeHint(status.active);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++statusRequestGeneration;
    const sessionEpoch = verifiedSessionEpoch;
    try {
      const botAdmin = await api.get<BotAdminStatus>('/api/v2/bot-admin/status');
      if (generation !== statusRequestGeneration) return;
      // Eine Antwort, die vor einer erfolgreich bestaetigten Anmeldung
      // gestartet wurde, darf diese neue Session niemals wiederrufen.
      if (!botAdmin.active && sessionEpoch !== verifiedSessionEpoch) return;
      if (botAdmin.active) {
        applyStatus(botAdmin, 'bot-admin');
        return;
      }

      // Kein BotAdminSession-Step-up vorhanden: nur eine bereits serverseitig
      // bestaetigte DEV-Session darf als zweiter Zugriffsweg gelten.
      try {
        const dev = await api.get<DevStatus>('/api/v2/dev/status');
        if (generation !== statusRequestGeneration || sessionEpoch !== verifiedSessionEpoch) return;
        if (dev.active && dev.eligible) {
          applyStatus({ active: true, expiresAt: dev.expiresAt ?? null }, 'dev');
          return;
        }
      } catch (e) {
        // Fuer normale Bot-Admins ist /dev/status erwartungsgemaess nicht
        // erreichbar. Das ist kein Fehler des Bot-Admin-Status.
        if (!(e instanceof ApiError) || (e.status !== 401 && e.status !== 403)) throw e;
      }

      if (generation !== statusRequestGeneration || sessionEpoch !== verifiedSessionEpoch) return;
      applyStatus({ active: false, expiresAt: null }, null);
    } catch (e) {
      if (generation !== statusRequestGeneration || sessionEpoch !== verifiedSessionEpoch) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        applyStatus({ active: false, expiresAt: null }, null);
      }
    } finally {
      if (generation === statusRequestGeneration) setLoading(false);
    }
  }, [applyStatus]);

  const login = useCallback(async (password: string): Promise<void> => {
    await api.post<{ ok: true; expiresAt: string }>('/api/v2/bot-admin/login', { password });

    // Ein 200 vom Passwort-Endpunkt allein reicht nicht: bevor die UI in den
    // geschuetzten Bereich navigiert, bestaetigt derselbe Server die frisch
    // persistierte BotAdminSession. Damit kann kein optimistischer UI-State
    // mehr direkt in "Bot-Admin-Session erforderlich" zurueckfallen.
    const generation = ++statusRequestGeneration;
    const status = await api.get<BotAdminStatus>('/api/v2/bot-admin/status');
    if (generation !== statusRequestGeneration) return;
    if (!status.active || !status.expiresAt) {
      applyStatus({ active: false, expiresAt: null }, null);
      throw new ApiError(
        'Passwort wurde akzeptiert, aber die Bot-Admin-Session konnte nicht bestaetigt werden.',
        503,
        'BOTADMIN_SESSION_CONFIRMATION_FAILED',
      );
    }
    ++verifiedSessionEpoch;
    applyStatus(status, 'bot-admin');
  }, [applyStatus]);

  const logout = useCallback(async (): Promise<void> => {
    // Ein DEV-basierter Zugriff besitzt keine separate BotAdminSession und darf
    // durch den Bot-Admin-Logout nicht versehentlich die DEV-Session widerrufen.
    if (source === 'dev') {
      await refresh();
      return;
    }
    try { await api.post('/api/v2/bot-admin/logout'); } catch { /* ignore */ }
    // Auch eine vor dem Logout gestartete Status-Abfrage darf den lokalen
    // Logout nicht nachtraeglich mit einem alten "aktiv" ueberschreiben.
    ++statusRequestGeneration;
    ++verifiedSessionEpoch;
    applyStatus({ active: false, expiresAt: null }, null);
  }, [applyStatus, refresh, source]);

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
    <Ctx.Provider value={{ active, expiresAt, source, loading, login, logout, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useBotAdminSession(): BotAdminSessionState {
  return useContext(Ctx);
}
