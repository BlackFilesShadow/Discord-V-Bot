import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, AUTH_EXPIRED_EVENT } from './api';

export interface SessionUser {
  discordId: string;
  username: string;
  avatar: string | null;
  role: 'USER' | 'ADMIN' | 'DEVELOPER';
}

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  sessionExpired: boolean;
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState>({ user: null, loading: true, sessionExpired: false, refresh: async () => {} });
const EXPIRED_SESSION_REDIRECT_DELAY_MS = 250;
export const AUTHENTICATED_SESSION_STORAGE_KEY = 'vbot:authenticated-session';

function hasAuthenticatedSessionMarker(): boolean {
  try { return sessionStorage.getItem(AUTHENTICATED_SESSION_STORAGE_KEY) === '1'; }
  catch { return false; }
}

function markAuthenticatedSession(): void {
  try { sessionStorage.setItem(AUTHENTICATED_SESSION_STORAGE_KEY, '1'); }
  catch { return; }
}

export function clearAuthenticatedSessionMarker(): void {
  try { sessionStorage.removeItem(AUTHENTICATED_SESSION_STORAGE_KEY); }
  catch { return; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await api.get<{ user: SessionUser }>('/api/me');
      setUser(data.user);
      setSessionExpired(false);
      markAuthenticatedSession();
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    // Ein einzelner 401 eines Fach-Endpunkts darf den sichtbaren Login nicht
    // blind verwerfen. /api/me ist die kanonische Session-Probe. Die laufende
    // Seite bleibt waehrend dieser Hintergrundpruefung gemountet, damit ein
    // legitimer fachlicher 401 seinen lokalen Fehlerzustand nicht verliert.
    // Erst wenn AUCH /api/me scheitert, gilt die Session als abgelaufen und
    // Protected leitet auf /login um.
    let pendingRevalidation: Promise<void> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    const onAuthExpired = () => {
      if (!hasAuthenticatedSessionMarker()) return;
      if (pendingRevalidation) return;
      pendingRevalidation = api.get<{ user: SessionUser }>('/api/me')
        .then(data => {
          if (expiryTimer) clearTimeout(expiryTimer);
          expiryTimer = null;
          setUser(data.user);
          setSessionExpired(false);
        })
        .catch((error: unknown) => {
          if (!(error instanceof ApiError) || error.status !== 401) return;
          // Die Mutation, welche das 401 ausgelöst hat, muss ihren lokalen
          // Fehlerzustand noch einmal rendern, bevor Protected zur Login-Seite
          // weiterleitet.
          expiryTimer = setTimeout(() => {
            setUser(null);
            setSessionExpired(true);
            expiryTimer = null;
          }, EXPIRED_SESSION_REDIRECT_DELAY_MS);
        })
        .finally(() => {
          pendingRevalidation = null;
        });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
      if (expiryTimer) clearTimeout(expiryTimer);
    };
  }, []);

  return <AuthCtx.Provider value={{ user, loading, sessionExpired, refresh }}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthCtx);
}
