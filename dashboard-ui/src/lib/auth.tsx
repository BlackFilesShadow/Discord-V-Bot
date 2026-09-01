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
    const onAuthExpired = () => {
      setUser(null);
      setLoading(false);
      setSessionExpired(true);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
  }, []);

  return <AuthCtx.Provider value={{ user, loading, sessionExpired, refresh }}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthCtx);
}
