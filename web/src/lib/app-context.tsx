import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Meta, User } from './types';

interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}

interface AppState {
  user: User | null;
  meta: Meta | null;
  ready: boolean;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
  toast: (text: string, kind?: Toast['kind']) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const refreshUser = useCallback(async () => {
    const { user } = await api.get<{ user: User | null }>('/api/auth/me');
    setUser(user);
    setMeta(user ? await api.get<Meta>('/api/meta') : null);
    setReady(true);
  }, []);

  useEffect(() => {
    refreshUser().catch(() => setReady(true));
    const onUnauthorized = () => {
      setUser(null);
      setMeta(null);
    };
    window.addEventListener('hp:unauthorized', onUnauthorized);
    return () => window.removeEventListener('hp:unauthorized', onUnauthorized);
  }, [refreshUser]);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (text: string, kind: Toast['kind'] = 'info') => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, kind, text }]);
      setTimeout(() => dismissToast(id), kind === 'error' ? 8000 : 4000);
    },
    [dismissToast],
  );

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    // Notices dismissed "for now" come back at the next sign-in.
    for (const k of Object.keys(sessionStorage)) if (k.startsWith('hp.notice.')) sessionStorage.removeItem(k);
    setUser(null);
    setMeta(null);
  }, []);

  const value = useMemo(
    () => ({ user, meta, ready, refreshUser, logout, toast, toasts, dismissToast }),
    [user, meta, ready, refreshUser, logout, toast, toasts, dismissToast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

/** Wraps an async action with toast feedback; returns the result or undefined on error. */
export function useAction() {
  const { toast } = useApp();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (success) toast(success, 'success');
        return r;
      } catch (err) {
        toast((err as Error).message, 'error');
        return undefined;
      }
    },
    [toast],
  );
}
