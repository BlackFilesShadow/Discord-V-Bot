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

  useEffect(() => {
    let cancelled = false;
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
        if (e instanceof ApiError && (e.status === 429 || e.status >= 500)) {
          setBackoffMs(prev => Math.min(prev === 0 ? 5_000 : prev * 2, 60_000));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path, tick]);

  useEffect(() => {
    if (intervalMs <= 0) return;
    const effective = Math.max(intervalMs, backoffMs);
    const t = setInterval(() => setTick(x => x + 1), effective);
    return () => clearInterval(t);
  }, [intervalMs, backoffMs]);

  return { data, loading, error, lastFetchedAt, reload: () => { setBackoffMs(0); setTick(x => x + 1); } };
}
