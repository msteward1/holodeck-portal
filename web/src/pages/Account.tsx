import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAction, useApp } from '../lib/app-context';
import { dateTime, relativeTime } from '../lib/format';
import { Field, InfoNote, PageHeader } from '../components/ui';

interface SessionInfo {
  current: boolean;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

/** Browser name from a user-agent string, good enough to recognise your own devices. */
function browserOf(ua: string | null) {
  if (!ua) return 'Unknown browser';
  const m = /(Edg|Firefox|Chrome|Safari)\/[\d.]+/.exec(ua);
  const name = m ? { Edg: 'Edge', Firefox: 'Firefox', Chrome: 'Chrome', Safari: 'Safari' }[m[1]] : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${name} on ${os}` : name;
}

function Sessions() {
  const run = useAction();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const load = useCallback(async () => {
    const r = await run(() => api.get<{ sessions: SessionInfo[] }>('/api/auth/sessions'));
    if (r) setSessions(r.sessions);
  }, [run]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!sessions) return null;
  const others = sessions.filter((s) => !s.current).length;
  return (
    <div className="panel mt-6 space-y-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">Signed-in sessions</div>
          <div className="text-sm text-slate-400">Every browser where you are signed in. Changing your password signs out all the others.</div>
        </div>
        <button
          className="btn-secondary shrink-0"
          disabled={others === 0}
          onClick={async () => {
            const r = await run(() => api.post<{ revokedSessions: number }>('/api/auth/sessions/revoke-others'));
            if (r) await load();
          }}
        >
          Sign out other sessions
        </button>
      </div>
      <ul className="divide-y divide-ink-700 text-sm">
        {sessions.map((s, i) => (
          <li key={i} className="flex items-center justify-between gap-3 py-2">
            <div>
              {browserOf(s.userAgent)}
              {s.current && <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 text-xs text-blue-200">This browser</span>}
              <div className="text-xs text-slate-400">{s.ip ?? 'unknown address'}</div>
            </div>
            <div className="text-right text-xs text-slate-400" title={`Expires ${dateTime(s.expiresAt)}`}>
              Signed in {relativeTime(s.createdAt)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Account() {
  const { user } = useApp();
  const run = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  if (!user) return null;
  return (
    <div className="max-w-lg">
      <PageHeader title="Account" subtitle={`${user.firstName} ${user.lastName} · ${user.username}`} />
      {user.authSource !== 'local' ? (
        <InfoNote>Your password is managed by your identity provider.</InfoNote>
      ) : (
        <form
          className="panel space-y-4 p-5"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(() => api.post('/api/auth/password', { current, next }), 'Password changed; other sessions were signed out');
            if (ok) {
              setCurrent('');
              setNext('');
              setConfirm('');
            }
          }}
        >
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" help="At least 10 characters.">
            <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirm new password">
            <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <button className="btn-primary" disabled={!current || next.length < 10 || next !== confirm}>
            Change password
          </button>
        </form>
      )}
      <Sessions key={user.id} />
    </div>
  );
}
