import { useState } from 'react';
import { Pencil, Plus, Trash2, UserX } from 'lucide-react';
import { api } from '../../lib/api';
import { useAction, useApp } from '../../lib/app-context';
import { useApi } from '../../lib/hooks';
import { relativeTime } from '../../lib/format';
import type { User } from '../../lib/types';
import { ConfirmDialog, Field, Modal, PageHeader, Spinner, Toggle } from '../../components/ui';

export function Users() {
  const { user: me } = useApp();
  const { data, reload } = useApi<{ users: User[] }>('/api/admin/users');
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const run = useAction();
  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Local accounts and users provisioned through single sign-on."
        actions={
          <button className="btn-primary" onClick={() => setEditing('new')}>
            <Plus className="size-4" /> New user
          </button>
        }
      />
      {!data ? (
        <Spinner className="mx-auto size-6" />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
                <th>Sign-in</th>
                <th>Labs / quota</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className={u.enabled ? '' : 'opacity-50'}>
                  <td>
                    <div className="font-medium text-white">
                      {u.firstName} {u.lastName}
                    </div>
                    <div className="font-mono text-xs text-slate-400">{u.username}</div>
                  </td>
                  <td className="text-slate-300">{u.email ?? '—'}</td>
                  <td>
                    <span className={`rounded-md px-2 py-0.5 text-xs ${u.role === 'admin' ? 'bg-violet-500/15 text-violet-300' : 'bg-ink-700 text-slate-300'}`}>{u.role}</span>
                    {!u.enabled && <span className="ml-2 text-xs text-red-300">disabled</span>}
                  </td>
                  <td className="text-slate-300 uppercase">{u.authSource}</td>
                  <td className="tabular-nums text-slate-300">
                    {u.activeLabs ?? 0} / {u.effectiveQuota}
                    {u.labQuota === null && <span className="ml-1 text-xs text-slate-500">(default)</span>}
                  </td>
                  <td className="text-slate-400">{relativeTime(u.lastLoginAt ?? null)}</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost p-1.5" onClick={() => setEditing(u)} title="Edit">
                      <Pencil className="size-4" />
                    </button>
                    {u.id !== me?.id && (
                      <button className="btn-ghost p-1.5 text-red-300" onClick={() => setDeleting(u)} title="Delete">
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <UserModal user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        danger
        title={`Delete ${deleting?.username}?`}
        confirmLabel="Delete"
        message={
          <>
            Users who have ever owned a lab can't be deleted (lab history keeps the owner); disable them instead.{' '}
            <UserX className="inline size-4" />
          </>
        }
        onConfirm={() => run(() => api.del(`/api/admin/users/${deleting!.id}`), 'User deleted').then(reload)}
      />
    </div>
  );
}

function UserModal({ user, onClose, onSaved }: { user: User | null; onClose: () => void; onSaved: () => void }) {
  const run = useAction();
  const [f, setF] = useState({
    username: user?.username ?? '',
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'user',
    authSource: user?.authSource ?? 'local',
    password: '',
    enabled: user?.enabled ?? true,
    useDefaultQuota: user ? user.labQuota === null : true,
    labQuota: user?.labQuota ?? 2,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    setBusy(true);
    const labQuota = f.useDefaultQuota ? null : f.labQuota;
    const ok = user
      ? await run(
          () =>
            api.patch(`/api/admin/users/${user.id}`, {
              firstName: f.firstName,
              lastName: f.lastName,
              email: f.email || null,
              role: f.role,
              enabled: f.enabled,
              labQuota,
              ...(f.password ? { password: f.password } : {}),
            }),
          'User updated',
        )
      : await run(
          () =>
            api.post('/api/admin/users', {
              username: f.username,
              firstName: f.firstName,
              lastName: f.lastName,
              email: f.email || undefined,
              role: f.role,
              authSource: f.authSource,
              password: f.authSource === 'local' ? f.password : undefined,
              labQuota,
            }),
          'User created',
        );
    setBusy(false);
    if (ok) {
      onSaved();
      onClose();
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={user ? `Edit ${user.username}` : 'New user'}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy} onClick={save}>
            {busy && <Spinner />} Save
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Username *" className="sm:col-span-2">
          <input className="input font-mono" value={f.username} disabled={Boolean(user)} onChange={(e) => set('username', e.target.value)} />
        </Field>
        <Field label="First name *">
          <input className="input" value={f.firstName} onChange={(e) => set('firstName', e.target.value)} />
        </Field>
        <Field label="Last name *">
          <input className="input" value={f.lastName} onChange={(e) => set('lastName', e.target.value)} />
        </Field>
        <Field label="Email" help="Optional; reserved for future email notifications." className="sm:col-span-2">
          <input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Role">
          <select className="input" value={f.role} onChange={(e) => set('role', e.target.value)}>
            <option value="user">User</option>
            <option value="admin">Administrator</option>
          </select>
        </Field>
        <Field
          label="Sign-in"
          help={
            !user && f.authSource !== 'local'
              ? 'Pre-registers an SSO user; linked to their IdP identity on first sign-in.'
              : user && user.authSource !== 'local'
                ? user.ssoLinked
                  ? 'Linked to an IdP identity. Another identity using this username is refused.'
                  : 'Not linked yet; the next sign-in with this username links it.'
                : undefined
          }
        >
          <select className="input" value={f.authSource} disabled={Boolean(user)} onChange={(e) => set('authSource', e.target.value)}>
            <option value="local">Local password</option>
            <option value="oidc">OIDC</option>
            <option value="saml">SAML</option>
          </select>
        </Field>
        {f.authSource === 'local' && (
          <Field label={user ? 'Reset password' : 'Password *'} help="At least 10 characters." className="sm:col-span-2">
            <input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} />
          </Field>
        )}
        <div className="space-y-3 sm:col-span-2">
          <Toggle checked={f.useDefaultQuota} onChange={(v) => set('useDefaultQuota', v)} label="Use the default lab quota" />
          {!f.useDefaultQuota && (
            <Field label="Lab quota" help="Maximum labs this user can have at once (0–10).">
              <input className="input max-w-32" type="number" min={0} max={10} value={f.labQuota} onChange={(e) => set('labQuota', Number(e.target.value))} />
            </Field>
          )}
          {user && user.authSource !== 'local' && user.ssoLinked && (
            <div className="rounded-lg border border-ink-700 p-3 text-sm text-slate-400">
              <div className="flex items-center justify-between gap-3">
                <span>Unlink the IdP identity, for example after a provider change or when the directory account was re-created. The next sign-in with this username links it again, and the user is signed out now.</span>
                <button
                  className="btn-secondary shrink-0"
                  onClick={async () => {
                    const ok = await run(() => api.post(`/api/admin/users/${user.id}/unlink-sso`), 'SSO identity unlinked');
                    if (ok) {
                      onSaved();
                      onClose();
                    }
                  }}
                >
                  Unlink SSO identity
                </button>
              </div>
            </div>
          )}
          {user && <Toggle checked={f.enabled} onChange={(v) => set('enabled', v)} label="Account enabled" help="Disabling signs the user out immediately." />}
        </div>
      </div>
    </Modal>
  );
}
