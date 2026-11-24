import { useEffect, useState } from 'react';
import { Eye, EyeOff, Monitor } from 'lucide-react';
import { api } from '../lib/api';
import { useAction, useApp } from '../lib/app-context';
import { dateTime } from '../lib/format';
import type { Lab, WebtopAccess } from '../lib/types';
import { CopyButton, ErrorNote, Field, InfoNote, Modal, Spinner, Toggle } from './ui';

interface Credential {
  component: string;
  account: string;
  password: string;
}

export function CredentialsModal({ lab, open, onClose }: { lab: Lab; open: boolean; onClose: () => void }) {
  const [creds, setCreds] = useState<Credential[] | null>(null);
  const [webtop, setWebtop] = useState<WebtopAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCreds(null);
    setReveal(false);
    api
      .get<{ credentials: Credential[]; webtop: WebtopAccess | null }>(`/api/labs/${lab.id}/credentials`)
      .then((r) => {
        setCreds(r.credentials);
        setWebtop(r.webtop);
      })
      .catch((e) => setError((e as Error).message));
  }, [open, lab.id]);

  const groups = new Map<string, Credential[]>();
  for (const c of creds ?? []) groups.set(c.component, [...(groups.get(c.component) ?? []), c]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`Credentials — ${lab.name}`}
      footer={
        <button className="btn-secondary" onClick={() => setReveal((r) => !r)}>
          {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />} {reveal ? 'Hide' : 'Reveal'} passwords
        </button>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {!creds && !error && <Spinner />}
      {webtop?.url && <WebtopPanel webtop={webtop} reveal={reveal} />}
      {lab.options?.ProvisionOnly === true && (
        <div className="mb-4">
          <InfoNote tone="warn">
            This lab was deployed with <strong>Provision only</strong> (-ProvisionOnly): Holodeck built the nested hosts and appliances, and the
            installation was finished by hand. Passwords chosen during that installation are not known to Holodeck, so the ones below match only
            where the same passwords were entered.
          </InfoNote>
        </div>
      )}
      {creds && creds.length === 0 && <p className="text-sm text-slate-400">No credentials were captured for this lab yet. Try “Refresh status”.</p>}
      {creds && creds.length > 0 && (
        <table className="table-base">
          <thead>
            <tr>
              <th>Component</th>
              <th>Account</th>
              <th>Password</th>
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([component, list]) =>
              list.map((c, i) => (
                <tr key={`${component}-${i}`}>
                  <td className="text-slate-200">{i === 0 ? component : ''}</td>
                  <td className="font-mono text-xs text-slate-300">
                    {c.account} <CopyButton text={c.account} />
                  </td>
                  <td className="font-mono text-xs">
                    <span className="text-slate-100">{reveal ? c.password : '•'.repeat(Math.min(12, c.password.length))}</span>
                    <CopyButton text={c.password} className="ml-1" />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
      <p className="mt-4 text-xs text-slate-500">Viewing credentials is recorded in the audit log.</p>
    </Modal>
  );
}

export function LeaseModal({ lab, open, onClose, onChanged }: { lab: Lab; open: boolean; onClose: () => void; onChanged: () => void }) {
  const { meta, user } = useApp();
  const run = useAction();
  const [days, setDays] = useState(7);
  const [powerOn, setPowerOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'admin';
  const maxDays = meta?.lease.maxDays ?? 365;
  const blocked = !isAdmin && (lab.lease.expired || !meta?.lease.usersCanExtend);
  const presets = [1, 3, 7, 14, 30].filter((d) => isAdmin || d <= maxDays);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={lab.lease.expired ? `Renew lease — ${lab.name}` : `Extend lease — ${lab.name}`}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={busy || blocked || days < 1}
            onClick={async () => {
              setBusy(true);
              const ok = await run(() => api.post(`/api/labs/${lab.id}/lease`, { days, powerOn: lab.lease.expired && powerOn }), 'Lease updated');
              setBusy(false);
              if (ok) {
                onChanged();
                onClose();
              }
            }}
          >
            {busy && <Spinner />} {lab.lease.expired ? 'Renew' : 'Extend'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-300">
          Current lease {lab.lease.expired ? 'expired' : 'ends'} <strong className="text-white">{dateTime(lab.lease.expiresAt)}</strong>.
        </p>
        {blocked && (
          <InfoNote tone="warn">
            {lab.lease.expired ? 'Expired leases can only be renewed by an administrator.' : 'Lease extensions are disabled. Contact an administrator.'}
          </InfoNote>
        )}
        <div className="flex flex-wrap gap-2">
          {presets.map((d) => (
            <button key={d} className={`btn-secondary ${days === d ? 'border-accent text-white' : ''}`} onClick={() => setDays(d)} disabled={blocked}>
              +{d}d
            </button>
          ))}
        </div>
        <Field label="Days to add" help={isAdmin ? 'Administrators are not limited by the maximum lease.' : `Leases can run up to ${maxDays} days from now.`}>
          <input className="input" type="number" min={1} step={1} value={days} disabled={blocked} onChange={(e) => setDays(Math.floor(Number(e.target.value)))} />
        </Field>
        {lab.lease.expired && isAdmin && <Toggle checked={powerOn} onChange={setPowerOn} label="Power the lab back on" />}
      </div>
    </Modal>
  );
}

/** The lab's way in: its Holorouter's webtop desktop (Firefox inside has the lab's DNS and shortcuts). */
export function WebtopPanel({ webtop, reveal }: { webtop: WebtopAccess; reveal: boolean }) {
  return (
    <div className="mb-5 rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-medium text-white">
            <Monitor className="size-4 text-blue-300" /> Lab access — webtop on {webtop.router}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Open the webtop and use Firefox inside it: lab names (and their DNS) only resolve from there.
            {webtop.viaPortal && ' It opens through the portal and signs you in; no password is needed.'}
          </p>
        </div>
        <a className="btn-primary" href={webtop.url!} target="_blank" rel="noreferrer">
          <Monitor className="size-4" /> Open webtop
        </a>
      </div>
      {webtop.username && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs">
          <span>
            <span className="text-slate-500">URL </span>
            <span className="text-slate-200">{webtop.url}</span> <CopyButton text={webtop.url!} />
          </span>
          <span>
            <span className="text-slate-500">user </span>
            <span className="text-slate-200">{webtop.username}</span> <CopyButton text={webtop.username} />
          </span>
          {webtop.password && (
            <span>
              <span className="text-slate-500">password </span>
              <span className="text-slate-200">{reveal ? webtop.password : '•'.repeat(12)}</span> <CopyButton text={webtop.password} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
