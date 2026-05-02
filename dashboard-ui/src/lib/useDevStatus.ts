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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get<T>(path)
      .then(r => {
        if (!cancelled) {
          setData(r);
          setLastFetchedAt(new Date());
        }
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Fehler.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path, tick]);

  useEffect(() => {
    if (intervalMs <= 0) return;
    const t = setInterval(() => setTick(x => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  return { data, loading, error, lastFetchedAt, reload: () => setTick(x => x + 1) };
}
