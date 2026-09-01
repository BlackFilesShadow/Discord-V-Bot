import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, AUTH_EXPIRED_EVENT } from './api';

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
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    // Ein einzelner 401 eines Fach-Endpunkts darf den sichtbaren Login nicht
    // blind verwerfen: Tests, kurzzeitige Route-Zustaende oder ein gezielt
    // abgelehnter Request koennen ebenfalls 401 liefern. /api/me ist die
    // kanonische Session-Probe. Erst wenn AUCH sie scheitert, gilt die Session
    // wirklich als abgelaufen und Protected leitet auf /login um.
    let pendingRevalidation: Promise<void> | null = null;
    const onAuthExpired = () => {
      if (pendingRevalidation) return;
      setLoading(true);
      pendingRevalidation = api.get<{ user: SessionUser }>('/api/me')
        .then(data => {
          setUser(data.user);
          setSessionExpired(false);
        })
        .catch(() => {
          setUser(null);
          setSessionExpired(true);
        })
        .finally(() => {
          setLoading(false);
          pendingRevalidation = null;
        });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
  }, []);

  return <AuthCtx.Provider value={{ user, loading, sessionExpired, refresh }}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthCtx);
}
