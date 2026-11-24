import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Boxes,
  CircleAlert,
  Clock,
  ExternalLink,
  KeyRound,
  Monitor,
  Router as RouterIcon,
  Layers,
  Network as NetworkIcon,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAction, useApp } from '../lib/app-context';
import { useNow } from '../lib/hooks';
import { countdown, jobTypeLabel, modeLabel } from '../lib/format';
import type { Lab } from '../lib/types';
import { ConfirmDialog, LabStatusBadge, PowerBadge } from './ui';
import { CredentialsModal, LeaseModal } from './LabModals';

const modeIcon = { VVF: Layers, ManagementOnly: Boxes, FullStack: Boxes };
const modeTint = {
  VVF: 'from-violet-500/30 to-fuchsia-500/20 text-violet-200',
  ManagementOnly: 'from-sky-500/30 to-blue-500/20 text-sky-200',
  FullStack: 'from-emerald-500/30 to-teal-500/20 text-emerald-200',
};

function leaseTone(lab: Lab, ms: number) {
  if (lab.lease.expired || ms <= 0) return { text: 'text-red-400', bar: 'bg-red-500' };
  if (lab.lease.warnedLevel >= 2) return { text: 'text-red-300', bar: 'bg-red-400' };
  if (lab.lease.warnedLevel >= 1) return { text: 'text-amber-300', bar: 'bg-amber-400' };
  return { text: 'text-emerald-400', bar: 'bg-emerald-500' };
}

function currentActivity(lab: Lab): { text: string; tone: string } {
  if (lab.activeJob) {
    const what = jobTypeLabel[lab.activeJob.type] ?? lab.activeJob.type;
    if (lab.activeJob.status === 'waiting_input') return { text: `${what} — waiting for your input`, tone: 'text-amber-300' };
    if (lab.activeJob.status === 'queued') return { text: `${what} — queued`, tone: 'text-slate-300' };
    return { text: `${what} — running…`, tone: 'text-sky-300' };
  }
  if (lab.status === 'failed') return { text: lab.error ?? 'Failed', tone: 'text-red-300' };
  if (lab.lease.expired) return { text: 'Lease expired — powered off', tone: 'text-red-300' };
  if (lab.status === 'ready') return { text: 'Idle', tone: 'text-slate-400' };
  return { text: lab.status, tone: 'text-slate-400' };
}

export function LabCard({ lab, onChanged, showOwner }: { lab: Lab; onChanged: () => void; showOwner?: boolean }) {
  const now = useNow(30_000);
  const navigate = useNavigate();
  const { user } = useApp();
  const run = useAction();
  const [menu, setMenu] = useState(false);
  const [creds, setCreds] = useState(false);
  const [lease, setLease] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  const Icon = modeIcon[lab.mode];
  const cd = countdown(lab.lease.expiresAt, now);
  const total = Date.parse(lab.lease.expiresAt) - Date.parse(lab.deployedAt ?? lab.createdAt);
  const pct = total > 0 ? Math.max(0, Math.min(100, (cd.ms / total) * 100)) : 0;
  const tone = leaseTone(lab, cd.ms);
  const activity = currentActivity(lab);
  const site = lab.sites.find((s) => s.site === lab.deploySite);
  const busy = Boolean(lab.activeJob);
  const isAdmin = user?.role === 'admin';

  const power = (action: 'start' | 'stop' | 'suspend') =>
    run(
      () => api.post(`/api/labs/${lab.id}/power`, { action }),
      { start: 'Power-on started', stop: 'Shutdown started', suspend: 'Suspend started' }[action],
    ).then(onChanged);

  return (
    <div className="panel group flex flex-col p-5 transition hover:border-ink-600">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className={`grid size-11 shrink-0 place-items-center rounded-full bg-gradient-to-br ${modeTint[lab.mode]} ring-1 ring-white/10`}>
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Link to={`/labs/${lab.id}`} className="block truncate text-[15px] font-semibold text-white hover:underline">
            {lab.name}
          </Link>
          <LabStatusBadge status={lab.status} />
        </div>
        <div className="flex items-center gap-1">
          {busy && <RefreshCw className="size-4 animate-spin text-emerald-400" aria-label="Job running" />}
          <div className="relative" ref={menuRef}>
            <button className="rounded-md p-1.5 text-slate-300 hover:bg-ink-700 hover:text-white" onClick={() => setMenu((m) => !m)} aria-label="Lab actions">
              <Settings2 className="size-[18px]" />
            </button>
            {menu && (
              <div className="panel absolute top-9 right-0 z-30 w-52 bg-ink-850 p-1.5 shadow-2xl" onClick={() => setMenu(false)}>
                <MenuItem icon={<ExternalLink />} label="Open details" onClick={() => navigate(`/labs/${lab.id}`)} />
                {lab.status === 'ready' && lab.hasCredentials && <MenuItem icon={<KeyRound />} label="Credentials" onClick={() => setCreds(true)} />}
                {lab.status !== 'removing' && <MenuItem icon={<Clock />} label={lab.lease.expired ? 'Renew lease' : 'Extend lease'} onClick={() => setLease(true)} />}
                {lab.status === 'ready' && !busy && lab.powerState !== 'on' && (!lab.lease.expired || isAdmin) && (
                  <MenuItem icon={<Play />} label={lab.powerState === 'suspended' ? 'Resume' : 'Power on'} onClick={() => power('start')} />
                )}
                {lab.status === 'ready' && !busy && ['on', 'partial'].includes(lab.powerState) && (
                  <MenuItem icon={<Pause />} label="Suspend" onClick={() => power('suspend')} />
                )}
                {lab.status === 'ready' && !busy && !['off', 'suspended'].includes(lab.powerState) && (
                  <MenuItem icon={<Power />} label="Shut down" onClick={() => power('stop')} />
                )}
                {(lab.status === 'ready' || lab.status === 'failed') && !busy && (
                  <MenuItem icon={<RefreshCw />} label="Refresh status" onClick={() => run(() => api.post(`/api/labs/${lab.id}/refresh`), 'Refresh started').then(onChanged)} />
                )}
                {lab.status === 'failed' && !busy && (
                  <MenuItem icon={<RotateCcw />} label="Retry deployment" onClick={() => run(() => api.post(`/api/labs/${lab.id}/retry`), 'Retry started').then(onChanged)} />
                )}
                {!['removing', 'removed'].includes(lab.status) && !busy && (
                  <MenuItem icon={<Trash2 />} label="Remove lab" danger onClick={() => setConfirmRemove(true)} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="mt-3 truncate text-sm text-slate-400">
        {modeLabel[lab.mode]} {lab.version}
        {lab.config && <> · {lab.config.name}</>}
      </p>
      {showOwner && lab.owner && <p className="truncate text-xs text-slate-500">Owner: {lab.owner.name || lab.owner.username}</p>}

      {/* Lease */}
      <div className="mt-4">
        <div className="label-caps">Lease remaining</div>
        <div className={`mt-1 text-4xl font-bold tracking-tight tabular-nums ${lab.lease.expired || cd.ms <= 0 ? 'text-red-400' : 'text-white'}`}>
          {lab.lease.expired || cd.ms <= 0 ? 'Expired' : cd.text}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <Meter label="Lease" pct={pct} barClass={tone.bar} valueClass={tone.text} value={`${Math.round(pct)}%`} />
        <div className="flex items-center gap-3 text-xs">
          <span className="label-caps w-16">Network</span>
          <NetworkIcon className="size-3.5 text-slate-500" />
          <span className="font-mono text-slate-200">{site?.cidr}</span>
          <span className="ml-auto font-mono text-slate-400">VLAN {site?.vlanStart}+</span>
        </div>
        {lab.holorouter && (
          <div className="flex items-center gap-3 text-xs">
            <span className="label-caps w-16">Router</span>
            <RouterIcon className="size-3.5 text-slate-500" />
            <span className="truncate text-slate-200">{lab.holorouter.name}</span>
          </div>
        )}
      </div>

      <div className="mt-4 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 font-mono text-xs">
        <span className="text-slate-500">CURRENT:</span> <span className={activity.tone}>{activity.text}</span>
      </div>

      {/* Footer */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-ink-700 pt-4 mt-5">
        <div className="flex items-center gap-2">
          <PowerBadge state={lab.powerState} />
          <span className="font-mono text-[11px] text-slate-500">{lab.instanceId}</span>
        </div>
        {lab.activeJob?.status === 'waiting_input' ? (
          <Link to={`/labs/${lab.id}?tab=activity`} className="btn rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20">
            <CircleAlert className="size-3.5" /> Answer prompt
          </Link>
        ) : lab.status === 'ready' && lab.holorouter?.webtopUrl ? (
          // Lab names only resolve inside the Holorouter's webtop, so that is the way in.
          <a href={lab.holorouter.webtopUrl} target="_blank" rel="noreferrer" className="btn rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-blue-200 hover:bg-accent/20" title="Open the lab's jump host">
            <Monitor className="size-3.5" /> Webtop
          </a>
        ) : lab.status === 'ready' && lab.links[0] && lab.powerState === 'on' ? (
          <a href={lab.links[0].url} target="_blank" rel="noreferrer" className="btn rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-blue-200 hover:bg-accent/20">
            <ExternalLink className="size-3.5" /> {lab.links[0].label}
          </a>
        ) : lab.status === 'failed' ? (
          <Link to={`/labs/${lab.id}?tab=activity`} className="btn rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20">
            View log
          </Link>
        ) : (
          <Link to={`/labs/${lab.id}`} className="btn-ghost px-3 py-1.5 text-xs">
            Details
          </Link>
        )}
      </div>

      <CredentialsModal lab={lab} open={creds} onClose={() => setCreds(false)} />
      <LeaseModal lab={lab} open={lease} onClose={() => setLease(false)} onChanged={onChanged} />
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        danger
        title={`Remove ${lab.name}?`}
        confirmLabel="Remove lab"
        requireText={lab.instanceId}
        message={
          <>
            All nested VMs for instance <code>{lab.instanceId}</code> will be deleted. Network slot {lab.slot} (
            {site?.cidr}) becomes available again. This cannot be undone.
          </>
        }
        onConfirm={() => run(() => api.del(`/api/labs/${lab.id}`), 'Removal started').then(onChanged)}
      />
    </div>
  );
}

function Meter({ label, pct, barClass, valueClass, value }: { label: string; pct: number; barClass: string; valueClass: string; value: string }) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="label-caps w-16">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`w-10 text-right font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm [&>svg]:size-4 ${
        danger ? 'text-red-300 hover:bg-red-500/10' : 'text-slate-200 hover:bg-ink-700'
      }`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}
