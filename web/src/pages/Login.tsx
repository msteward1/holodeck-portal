import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { LogIn, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { ErrorNote, Spinner } from '../components/ui';

interface Providers {
  portalName: string;
  local: boolean;
  oidc: { displayName: string } | null;
  saml: { displayName: string } | null;
}

export function Login() {
  const { user, refreshUser } = useApp();
  const [params] = useSearchParams();
  const [providers, setProviders] = useState<Providers | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(params.get('error'));
  const [busy, setBusy] = useState(false);
  const [showLocal, setShowLocal] = useState(false);

  useEffect(() => {
    api.get<Providers>('/api/auth/providers').then(setProviders).catch(() => undefined);
  }, []);

  if (user) return <Navigate to="/" replace />;
  const sso = providers && (providers.oidc || providers.saml);
  const localVisible = providers && (providers.local || showLocal);

  return (
    <div className="grid min-h-full place-items-center bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.15),transparent_60%)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img src="/favicon.svg" alt="" className="size-14 rounded-2xl" />
          <h1 className="text-2xl font-semibold text-white">{providers?.portalName ?? 'Holodeck Portal'}</h1>
          <p className="text-sm text-slate-400">Self-service nested VCF labs</p>
        </div>
        <div className="panel space-y-4 p-6">
          {error && <ErrorNote>{error}</ErrorNote>}
          {providers?.oidc && (
            <a className="btn-primary w-full" href="/api/auth/oidc/login">
              <ShieldCheck className="size-4" /> {providers.oidc.displayName}
            </a>
          )}
          {providers?.saml && (
            <a className="btn-secondary w-full" href="/api/auth/saml/login">
              <ShieldCheck className="size-4" /> {providers.saml.displayName}
            </a>
          )}
          {sso && localVisible && (
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="h-px flex-1 bg-ink-700" /> or <span className="h-px flex-1 bg-ink-700" />
            </div>
          )}
          {localVisible && (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                try {
                  await api.post('/api/auth/login', { username, password });
                  await refreshUser();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <input className="input" placeholder="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
              <input
                className="input"
                placeholder="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button className={sso ? 'btn-secondary w-full' : 'btn-primary w-full'} disabled={busy || !username || !password}>
                {busy ? <Spinner /> : <LogIn className="size-4" />} Sign in
              </button>
            </form>
          )}
          {providers && !providers.local && !showLocal && (
            <button className="w-full text-center text-xs text-slate-500 hover:text-slate-300" onClick={() => setShowLocal(true)}>
              Administrator sign-in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
