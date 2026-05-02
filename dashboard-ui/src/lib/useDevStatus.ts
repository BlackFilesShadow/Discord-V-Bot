/**
 * Wiederverwendbarer Polling-Hook fuer DEV-Status-Endpoints.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

export interface PolledStatus<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  lastFetchedAt: Date | null;
}

export function useDevStatus<T>(path: string, intervalMs = 10_000): PolledStatus<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  // Backoff bei 429 / 5xx, damit das Polling sich selbst heilt statt
  // den Rate-Limit weiter zu fluten.
  const [backoffMs, setBackoffMs] = useState(0);
  // Hard-Stop bei strukturellen Auth-Fehlern (401, 403 mit DEV_MFA_REQUIRED
  // oder DEV_LOGIN_REQUIRED). Polling laeuft sonst gegen die Wand und
  // erzeugt Toast-Spam + Server-Last.
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (stopped) return () => { cancelled = true; };
    setLoading(true);
    setError(null);
    api.get<T>(path)
      .then(r => {
        if (cancelled) return;
        setData(r);
        setLastFetchedAt(new Date());
        setBackoffMs(0);
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Fehler.');
        if (e instanceof ApiError) {
          const code = e.code ?? '';
          if (e.status === 401 || code === 'DEV_LOGIN_REQUIRED' || code === 'DEV_MFA_REQUIRED' || code === 'DEV_IP_DENIED') {
            setStopped(true);
            return;
          }
          if (e.status === 429 || e.status >= 500) {
            setBackoffMs(prev => Math.min(prev === 0 ? 5_000 : prev * 2, 60_000));
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path, tick, stopped]);

  useEffect(() => {
    if (intervalMs <= 0 || stopped) return;
    const effective = Math.max(intervalMs, backoffMs);
    const t = setInterval(() => setTick(x => x + 1), effective);
    return () => clearInterval(t);
  }, [intervalMs, backoffMs, stopped]);

  return {
    data, loading, error, lastFetchedAt,
    reload: () => { setBackoffMs(0); setStopped(false); setTick(x => x + 1); },
  };
}
