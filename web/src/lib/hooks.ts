import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Fetches `path` and optionally re-polls it. `path = null` skips the request. */
export function useApi<T>(path: string | null, opts: { interval?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    try {
      const d = await api.get<T>(p);
      if (pathRef.current === p) {
        setData(d);
        setError(null);
      }
    } catch (err) {
      if (pathRef.current === p) setError((err as Error).message);
    } finally {
      if (pathRef.current === p) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(Boolean(path));
    setData(null);
    void reload();
    if (!path || !opts.interval) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, opts.interval);
    return () => clearInterval(t);
  }, [path, opts.interval, reload]);

  return { data, error, loading, reload, setData };
}

/** Re-renders every `ms` (for countdowns and clocks). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);
  return [value, setValue] as const;
}
