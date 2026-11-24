import { useEffect, useMemo, useState } from 'react';
import { describeIdle } from '../components/IdleStages';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, Clock, Copy, ExternalLink, FileWarning, KeyRound, Monitor, Pause, Play, Power, RefreshCw, RotateCcw, Trash2, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { useAction, useApp } from '../lib/app-context';
import { useApi, useNow } from '../lib/hooks';
import { countdown, dateTime, modeLabel } from '../lib/format';
import type { ActionDef, Lab, User } from '../lib/types';
import { CredentialsModal, LeaseModal } from '../components/LabModals';
import { JobConsole } from '../components/JobConsole';
import { FieldForm, fieldDefaults } from '../components/FieldForm';
import { ConfirmDialog, CopyButton, ErrorNote, Field, InfoNote, LabStatusBadge, Modal, PowerBadge, Spinner, Tabs, Toggle } from '../components/ui';
import { ActivityList } from './Activity';

type Tab = 'overview' | 'access' | 'network' | 'activity' | 'day2' | 'settings';

export function LabDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const setTab = (t: Tab) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true });
  const { data, error, reload } = useApi<{ lab: Lab }>(`/api/labs/${id}`, { interval: 6000 });
  const lab = data?.lab;
  // Opening the lab counts as use for the idle policy: once per visit, not on every refresh (a forgotten tab
  // shouldn't keep a lab running). The server only counts the owner.
  useEffect(() => {
    if (id) void api.post(`/api/labs/${id}/activity`, { kind: 'seen' }).catch(() => undefined);
  }, [id]);
  if (error && !lab) return <ErrorNote>{error}</ErrorNote>;
  if (!lab) return <Spinner className="mx-auto size-6" />;

  return (
    <div>
      <LabHeader lab={lab} onChanged={reload} />
      <div className="mt-6">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'access', label: 'Access' },
            { id: 'network', label: 'Network' },
            {
              id: 'activity',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Activity {lab.activeJob && <span className={`size-1.5 rounded-full ${lab.activeJob.status === 'waiting_input' ? 'bg-amber-400' : 'bg-sky-400'} animate-pulse`} />}
                </span>
              ),
            },
            { id: 'day2', label: 'Day-2' },
            { id: 'settings', label: 'Settings' },
          ]}
        />
      </div>
      <div className="mt-6">
        {tab === 'overview' && <Overview lab={lab} />}
        {tab === 'access' && <Access lab={lab} />}
        {tab === 'network' && <NetworkTab lab={lab} />}
        {tab === 'activity' && <ActivityTab lab={lab} onChanged={reload} />}
        {tab === 'day2' && <Day2Tab lab={lab} onStarted={() => (void reload(), setTab('activity'))} />}
        {tab === 'settings' && <SettingsTab lab={lab} onChanged={reload} />}
      </div>
    </div>
  );
}

function LabHeader({ lab, onChanged }: { lab: Lab; onChanged: () => void }) {
  const { user } = useApp();
  const run = useAction();
  const now = useNow(30_000);
  const [creds, setCreds] = useState(false);
  const [lease, setLease] = useState(false);
  const [confirm, setConfirm] = useState<null | 'remove' | 'stop' | 'force' | 'suspend'>(null);
  const isAdmin = user?.role === 'admin';
  const busy = Boolean(lab.activeJob);
  const ready = lab.status === 'ready';
  const cd = countdown(lab.lease.expiresAt, now);
  const site = lab.sites.find((s) => s.site === lab.deploySite);
  const post = (path: string, body: unknown, msg: string) => run(() => api.post(path, body), msg).then(onChanged);

  return (
    <div className="panel p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-white">{lab.name}</h1>
            <LabStatusBadge status={lab.status} />
            <PowerBadge state={lab.powerState} />
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {modeLabel[lab.mode]} {lab.version} · instance <span className="font-mono text-slate-300">{lab.instanceId}</span> · {site?.cidr}
            {lab.owner && <> · {lab.owner.name || lab.owner.username}</>}
          </p>
          {lab.description && <p className="mt-2 max-w-3xl text-sm text-slate-300">{lab.description}</p>}
        </div>
        <div className="text-right">
          <div className="label-caps">Lease</div>
          <div className={`text-2xl font-bold tabular-nums ${lab.lease.expired || cd.ms <= 0 ? 'text-red-400' : lab.lease.warnedLevel ? 'text-amber-300' : 'text-white'}`}>
            {lab.lease.expired || cd.ms <= 0 ? 'Expired' : cd.text}
          </div>
          <div className="text-xs text-slate-500">{dateTime(lab.lease.expiresAt)}</div>
        </div>
      </div>

      {lab.status === 'failed' && lab.error && (
        <div className="mt-4">
          <ErrorNote>{lab.error}</ErrorNote>
        </div>
      )}
      <IdleNote lab={lab} onChanged={onChanged} />
      {lab.lease.expired && (
        <div className="mt-4">
          <InfoNote tone="warn">
            This lab's lease has expired and it has been powered off. {isAdmin ? 'Renew the lease to bring it back, or remove it.' : 'Ask an administrator to renew it.'}
          </InfoNote>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {ready && lab.hasCredentials && (
          <button className="btn-secondary" onClick={() => setCreds(true)}>
            <KeyRound className="size-4" /> Credentials
          </button>
        )}
        {lab.status !== 'removing' && lab.status !== 'removed' && (
          <button className="btn-secondary" onClick={() => setLease(true)}>
            <Clock className="size-4" /> {lab.lease.expired ? 'Renew lease' : 'Extend lease'}
          </button>
        )}
        {ready && lab.powerState !== 'on' && (!lab.lease.expired || isAdmin) && (
          <button className="btn-secondary" disabled={busy} onClick={() => post(`/api/labs/${lab.id}/power`, { action: 'start' }, 'Power-on started')}>
            <Play className="size-4" /> {lab.powerState === 'suspended' ? 'Resume' : 'Power on'}
          </button>
        )}
        {ready && ['on', 'partial'].includes(lab.powerState) && (
          <button className="btn-secondary" disabled={busy} onClick={() => setConfirm('suspend')}>
            <Pause className="size-4" /> Suspend
          </button>
        )}
        {ready && !['off', 'suspended'].includes(lab.powerState) && (
          <button className="btn-secondary" disabled={busy} onClick={() => setConfirm('stop')}>
            <Power className="size-4" /> Shut down
          </button>
        )}
        {ready && isAdmin && lab.powerState !== 'off' && (
          <button className="btn-secondary" disabled={busy} onClick={() => setConfirm('force')}>
            <Zap className="size-4" /> Force off
          </button>
        )}
        {(ready || lab.status === 'failed') && (
          <button className="btn-secondary" disabled={busy} onClick={() => post(`/api/labs/${lab.id}/refresh`, {}, 'Refresh started')}>
            <RefreshCw className="size-4" /> Refresh
          </button>
        )}
        {lab.status === 'failed' && (
          <>
            <button className="btn-primary" disabled={busy} onClick={() => post(`/api/labs/${lab.id}/retry`, {}, 'Retry started')}>
              <RotateCcw className="size-4" /> Retry deployment
            </button>
            <button className="btn-secondary" disabled={busy} onClick={() => post(`/api/labs/${lab.id}/diagnostics`, { full: true }, 'Diagnostics export started')}>
              <FileWarning className="size-4" /> Export diagnostics
            </button>
          </>
        )}
        {!['removing', 'removed'].includes(lab.status) && (
          <button className="btn-danger ml-auto" disabled={busy} onClick={() => setConfirm('remove')}>
            <Trash2 className="size-4" /> Remove
          </button>
        )}
      </div>

      <CredentialsModal lab={lab} open={creds} onClose={() => setCreds(false)} />
      <LeaseModal lab={lab} open={lease} onClose={() => setLease(false)} onChanged={onChanged} />
      <ConfirmDialog
        open={confirm === 'stop'}
        onClose={() => setConfirm(null)}
        title="Shut down this lab?"
        confirmLabel="Shut down"
        message="Holodeck shuts down the workload domain, then the management domain, then powers off the nested ESX hosts; the portal then shuts down the VCF Installer / Cloud Builder VM. This takes several minutes."
        onConfirm={() => post(`/api/labs/${lab.id}/power`, { action: 'stop' }, 'Shutdown started')}
      />
      <ConfirmDialog
        open={confirm === 'suspend'}
        onClose={() => setConfirm(null)}
        title="Suspend this lab?"
        confirmLabel="Suspend"
        message={
          <>
            All of the lab’s VMs are suspended together, so everything inside resumes where it left off. vSphere writes each VM’s memory to
            its datastore (about the lab’s total configured memory, e.g. ~770 GB for a VCF 9.1 management domain); the job checks there is
            room first. Expect clock catch-up and a few alarms inside the lab after resuming.
          </>
        }
        onConfirm={() => post(`/api/labs/${lab.id}/power`, { action: 'suspend' }, 'Suspend started')}
      />
      <ConfirmDialog
        open={confirm === 'force'}
        onClose={() => setConfirm(null)}
        danger
        title="Force power off?"
        confirmLabel="Force off"
        message="Hard powers off the lab's VMs on the target vCenter without a graceful VCF shutdown. vSAN or appliances may need recovery afterwards."
        onConfirm={() => post(`/api/labs/${lab.id}/power`, { action: 'force-off' }, 'Force power-off started')}
      />
      <ConfirmDialog
        open={confirm === 'remove'}
        onClose={() => setConfirm(null)}
        danger
        title={`Remove ${lab.name}?`}
        confirmLabel="Remove lab"
        requireText={lab.instanceId}
        message={
          <>
            Deletes every VM of instance <code>{lab.instanceId}</code> Slot {lab.slot} ({site?.cidr}) is released.
          </>
        }
        onConfirm={() => run(() => api.del(`/api/labs/${lab.id}`), 'Removal started').then(onChanged)}
      />
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-b border-ink-700/60 py-2 text-sm last:border-0">
      <span className="text-slate-400">{k}</span>
      <span className={`text-right text-slate-100 ${mono ? 'font-mono text-xs' : ''}`}>{v}</span>
    </div>
  );
}

function Overview({ lab }: { lab: Lab }) {
  const opts = Object.entries(lab.options).filter(([k]) => !['mode', 'version'].includes(k));
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="panel p-5">
        <h3 className="label-caps mb-2">Deployment</h3>
        <KV k="Configuration" v={lab.config?.name ?? '—'} />
        <KV k="Holodeck config ID" v={lab.config?.configId ?? '—'} mono />
        <KV k="Type" v={`${modeLabel[lab.mode]} ${lab.version}`} />
        <KV k="Instance ID" v={lab.instanceId} mono />
        <KV k="DNS domain" v={lab.domain ?? (lab.options.DNSDomain as string) ?? 'Holodeck default'} mono />
        <KV k="Created" v={dateTime(lab.createdAt)} />
        <KV k="Deployed" v={dateTime(lab.deployedAt)} />
        {lab.usesSharedRouted && <KV k="Shared routed networks" v="Supervisor / VCF Automation (10.100.x)" />}
      </div>
      <div className="panel p-5">
        <h3 className="label-caps mb-2">Holodeck options</h3>
        {opts.length === 0 ? (
          <p className="text-sm text-slate-400">Defaults</p>
        ) : (
          opts.map(([k, v]) => <KV key={k} k={`-${k}`} v={v === true ? 'on' : String(v)} mono />)
        )}
      </div>
      <div className="panel p-5 lg:col-span-2">
        <h3 className="label-caps mb-3">Nested VMs</h3>
        {lab.nodes?.length ? (
          <table className="table-base">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>IP</th>
                <th>Power</th>
                <th>Reachable</th>
              </tr>
            </thead>
            <tbody>
              {lab.nodes.map((n) => (
                <tr key={n.name}>
                  <td className="font-mono text-xs">{n.name}</td>
                  <td className="text-slate-300">{n.type.replace(/_/g, ' ')}</td>
                  <td className="font-mono text-xs">{n.ip}</td>
                  <td className="text-slate-300">{n.powerState ?? '—'}</td>
                  <td>{n.reachable ? <span className="text-emerald-400">yes</span> : <span className="text-slate-500">no</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-slate-400">Node details appear once the deployment completes (or after “Refresh”).</p>
        )}
      </div>
    </div>
  );
}

function Access({ lab }: { lab: Lab }) {
  const [creds, setCreds] = useState(false);
  const [q, setQ] = useState('');
  const endpoints = useMemo(
    () => (lab.endpoints ?? []).filter((e) => !q || `${e.hostname} ${e.fqdn} ${e.ip}`.toLowerCase().includes(q.toLowerCase())),
    [lab.endpoints, q],
  );
  return (
    <div className="space-y-6">
      {lab.holorouter?.webtopUrl && lab.status !== 'removed' && (
        <div className="panel flex flex-wrap items-center justify-between gap-4 border-blue-500/30 p-5">
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-white">
              <Monitor className="size-4 text-blue-300" /> Webtop on {lab.holorouter.name}
            </h3>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Your way into the lab: a desktop on the lab's Holorouter. Use Firefox inside it for the consoles below; lab names only
              resolve there. The login is in <button className="text-blue-300 hover:underline" onClick={() => setCreds(true)}>credentials</button>.
            </p>
          </div>
          <a className="btn-primary" href={lab.holorouter.webtopUrl} target="_blank" rel="noreferrer">
            <Monitor className="size-4" /> Open webtop
          </a>
        </div>
      )}
      <div className="panel p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="label-caps">Consoles</h3>
          {lab.hasCredentials && (
            <button className="btn-secondary" onClick={() => setCreds(true)}>
              <KeyRound className="size-4" /> View credentials
            </button>
          )}
        </div>
        {lab.links.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {lab.links.map((l) => (
              <ConsoleCard key={l.label} link={l} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400">Console links appear once the lab is deployed.</p>
        )}
        <p className="mt-4 text-xs text-slate-500">
          Click a console to copy its address, then paste it into Firefox in the webtop: lab names (
          <span className="font-mono">{lab.domain ?? 'the lab domain'}</span>) resolve through the Holorouter's DNS, and lab networks are
          only routed from there. <ExternalLink className="inline size-3" /> opens a console directly, for networks where lab traffic is routed.
        </p>
      </div>

      <div className="panel p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="label-caps">DNS records ({lab.endpoints?.length ?? 0})</h3>
          <input className="input max-w-xs py-1.5" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="max-h-[28rem] overflow-y-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Hostname</th>
                <th>FQDN</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e) => (
                <tr key={`${e.fqdn}-${e.ip}`}>
                  <td className="font-mono text-xs">{e.hostname}</td>
                  <td className="font-mono text-xs text-slate-300">
                    {e.fqdn} <CopyButton text={e.fqdn} />
                  </td>
                  <td className="font-mono text-xs">{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <CredentialsModal lab={lab} open={creds} onClose={() => setCreds(false)} />
    </div>
  );
}

function NetworkTab({ lab }: { lab: Lab }) {
  const subnets = lab.network?.subnets ?? [];
  const bgp = lab.network?.bgp;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        {lab.sites.map((s) => (
          <div key={s.site} className="panel p-5">
            <div className="flex items-center justify-between">
              <h3 className="label-caps">Site {s.site.toUpperCase()}</h3>
              {s.reserved ? <span className="text-xs text-slate-500">Reserved</span> : <span className="text-xs text-emerald-400">Deployed</span>}
            </div>
            <div className="mt-2 font-mono text-lg text-white">{s.cidr}</div>
            <div className="font-mono text-xs text-slate-400">
              VLANs {s.vlanStart}–{s.vlanEnd}
            </div>
          </div>
        ))}
      </div>
      {bgp && (
        <div className="panel flex flex-wrap gap-8 p-5 text-sm">
          <span>
            <span className="label-caps mr-2">Router AS</span>
            <span className="font-mono">{bgp.routerAs}</span>
          </span>
          <span>
            <span className="label-caps mr-2">Edge mgmt AS</span>
            <span className="font-mono">{bgp.edgeMgmtAs}</span>
          </span>
          <span>
            <span className="label-caps mr-2">Edge wkld AS</span>
            <span className="font-mono">{bgp.edgeWldAs}</span>
          </span>
        </div>
      )}
      <div className="panel overflow-x-auto p-5">
        <h3 className="label-caps mb-3">Subnets</h3>
        {subnets.length ? (
          <table className="table-base">
            <thead>
              <tr>
                <th>Name</th>
                <th>VLAN</th>
                <th>Subnet</th>
                <th>Gateway</th>
                <th>DHCP</th>
              </tr>
            </thead>
            <tbody>
              {subnets.map((s) => (
                <tr key={s.name}>
                  <td className="font-mono text-xs">{s.name}</td>
                  <td className="font-mono text-xs">{s.vlan || 'untagged'}</td>
                  <td className="font-mono text-xs text-white">{s.subnet}</td>
                  <td className="font-mono text-xs">{s.gateway || '—'}</td>
                  <td className="font-mono text-xs text-slate-400">{s.dhcp === 'Enabled' ? `${s.dhcpStart} – ${s.dhcpEnd}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-slate-400">Subnet details are captured when the deployment completes.</p>
        )}
      </div>
    </div>
  );
}

function ActivityTab({ lab, onChanged }: { lab: Lab; onChanged: () => void }) {
  const [selected, setSelected] = useState<string | null>(lab.activeJob?.id ?? lab.lastJobId);
  useEffect(() => {
    if (lab.activeJob) setSelected(lab.activeJob.id);
  }, [lab.activeJob?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-6">
      {selected && <JobConsole jobId={selected} onFinished={onChanged} />}
      <ActivityList labId={lab.id} onSelect={setSelected} selected={selected} />
    </div>
  );
}

function Day2Tab({ lab, onStarted }: { lab: Lab; onStarted: () => void }) {
  const { meta } = useApp();
  const [action, setAction] = useState<ActionDef | null>(null);
  const actions = (meta?.day2Actions ?? []).filter((a) => !a.v9Only || lab.version.startsWith('9.'));
  if (lab.status !== 'ready') return <InfoNote>Day-2 operations are available once the lab is ready.</InfoNote>;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {actions.map((a) => (
        <div key={a.id} className="panel flex flex-col p-5">
          <h3 className="font-medium text-white">{a.label}</h3>
          <p className="mt-1 flex-1 text-sm text-slate-400">{a.description}</p>
          {a.sharedRouted && <p className="mt-2 text-xs text-amber-300">Uses the shared 10.100.x routed networks — only one lab at a time.</p>}
          <button className="btn-secondary mt-4 self-start" disabled={Boolean(lab.activeJob)} onClick={() => setAction(a)}>
            Configure…
          </button>
        </div>
      ))}
      {action && <Day2Modal lab={lab} action={action} onClose={() => setAction(null)} onStarted={onStarted} />}
    </div>
  );
}

function Day2Modal({ lab, action, onClose, onStarted }: { lab: Lab; action: ActionDef; onClose: () => void; onStarted: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => fieldDefaults(action.fields));
  const [busy, setBusy] = useState(false);
  const run = useAction();
  const { user } = useApp();
  const addsHosts = action.id === 'NewHostsCustom' || action.id === 'AddCluster';
  const unconfirmed = Boolean(lab.hosts?.unconfirmed && addsHosts);
  return (
    <Modal
      open
      onClose={onClose}
      title={action.label}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={busy || unconfirmed}
            onClick={async () => {
              setBusy(true);
              const ok = await run(() => api.post(`/api/labs/${lab.id}/day2`, { action: action.id, values }), `${action.label} started`);
              setBusy(false);
              if (ok) {
                onClose();
                onStarted();
              }
            }}
          >
            {busy && <Spinner />} Run
          </button>
        </>
      }
    >
      <p className="mb-4 text-sm text-slate-400">{action.description}</p>
      {unconfirmed && (
        <div className="mb-4 space-y-2">
          <InfoNote tone="warn">
            An earlier expansion of this lab failed or was cancelled, so the hosts it may have created still count until the lab is refreshed.
            A refresh starts automatically; when it finishes, you can add hosts again.
          </InfoNote>
          {user?.role === 'admin' && (
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await run(() => api.post(`/api/labs/${lab.id}/reconcile-hosts`), 'Host count accepted');
                setBusy(false);
                if (ok) {
                  onClose();
                  onStarted();
                }
              }}
            >
              Accept the current host count (admin)
            </button>
          )}
        </div>
      )}
      {lab.hosts && addsHosts && (
        <p className="mb-4 text-sm text-slate-400">
          Site {lab.hosts.site.toUpperCase()} has {lab.hosts.count} of at most {lab.hosts.max} hosts
          {lab.hosts.count >= lab.hosts.max ? ' — no more can be added.' : ` (${lab.hosts.max - lab.hosts.count} more allowed).`}
        </p>
      )}
      {action.fields.length ? <FieldForm fields={action.fields} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} columns={1} /> : null}
    </Modal>
  );
}

function SettingsTab({ lab, onChanged }: { lab: Lab; onChanged: () => void }) {
  const { user } = useApp();
  const run = useAction();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  const users = useApi<{ users: User[] }>(isAdmin ? '/api/admin/users' : null);
  const [name, setName] = useState(lab.name);
  const [description, setDescription] = useState(lab.description);
  const [ownerId, setOwnerId] = useState(lab.owner?.id ?? 0);
  const [forget, setForget] = useState(false);
  return (
    <div className="max-w-2xl space-y-6">
      <div className="panel space-y-4 p-5">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <Field label="Description">
          <textarea className="input min-h-24" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        {isAdmin && (
          <Field label="Owner">
            <select className="input" value={ownerId} onChange={(e) => setOwnerId(Number(e.target.value))}>
              {users.data?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.firstName} {u.lastName} ({u.username})
                </option>
              ))}
            </select>
          </Field>
        )}
        <button
          className="btn-primary"
          onClick={() =>
            run(
              () => api.patch(`/api/labs/${lab.id}`, { name, description, ...(isAdmin && ownerId !== lab.owner?.id ? { ownerId } : {}) }),
              'Saved',
            ).then(onChanged)
          }
        >
          Save
        </button>
      </div>
      {isAdmin && lab.idle && (
        <div className="panel space-y-3 p-5">
          <h3 className="font-medium text-white">Idle policy</h3>
          <Toggle
            checked={lab.idle.exempt}
            onChange={(v) => void run(() => api.patch(`/api/labs/${lab.id}`, { idleExempt: v }), v ? 'Lab exempted' : 'Exemption removed').then(onChanged)}
            label="Never suspend or shut down this lab for inactivity"
          />
          <p className="text-xs text-slate-400">
            Its router's policy: {describeIdle(lab.idle.policy)}
            {lab.idle.policy.source === 'default' ? ' (the default)' : lab.idle.policy.source === 'custom' ? " (the router's own)" : ''}.
          </p>
        </div>
      )}
      {isAdmin && lab.status !== 'removed' && (
        <div className="panel border-red-500/30 p-5">
          <h3 className="font-medium text-white">Forget lab</h3>
          <p className="mt-1 text-sm text-slate-400">
            Marks the lab removed in the portal and frees its network slot without running Holodeck. Use only after the instance was removed outside the portal.
          </p>
          <button className="btn-danger mt-3" onClick={() => setForget(true)}>
            Forget lab
          </button>
          <ConfirmDialog
            open={forget}
            onClose={() => setForget(false)}
            danger
            title="Forget this lab?"
            confirmLabel="Forget"
            requireText={lab.instanceId}
            message="No VMs are touched. If the instance still exists, its network slot could be handed to a new lab and collide."
            onConfirm={() => run(() => api.post(`/api/labs/${lab.id}/forget`), 'Lab forgotten').then(() => navigate('/'))}
          />
        </div>
      )}
    </div>
  );
}

/** A console: clicking copies its URL (the default while labs are only reachable from the webtop); the icon opens it. */
function ConsoleCard({ link }: { link: { label: string; url: string; fqdn: string; ip: string } }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(link.url).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      title={`Copy ${link.url}`}
      onClick={() => void copy()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), void copy())}
      className="group cursor-pointer rounded-xl border border-ink-700 bg-ink-900 p-4 transition hover:border-accent/60 focus:border-accent/60 focus:outline-none"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-white">{link.label}</span>
        <span className="flex items-center gap-1">
          <span className="rounded p-1 text-slate-500 group-hover:text-slate-300">
            {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
          </span>
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            title="Open directly"
            onClick={(e) => e.stopPropagation()}
            className="rounded p-1 text-slate-500 hover:bg-ink-700 hover:text-blue-300"
          >
            <ExternalLink className="size-4" />
          </a>
        </span>
      </div>
      <div className="mt-1 font-mono text-xs text-slate-400">{copied ? 'Address copied' : link.fqdn}</div>
      <div className="font-mono text-xs text-slate-500">{link.ip}</div>
    </div>
  );
}

/** Idle policy: how long the lab has been unused and what happens next, with Keep running. */
function IdleNote({ lab, onChanged }: { lab: Lab; onChanged: () => void }) {
  const { user } = useApp();
  const run = useAction();
  const now = useNow(60_000);
  const idle = lab.idle;
  if (!idle?.enabled || !idle.next || lab.status !== 'ready') return null;
  const canKeep = user?.role === 'admin' || user?.id === lab.owner?.id;
  const left = Date.parse(idle.next.at) - now;
  const soon = left < 24 * 3600_000;
  const when = left <= 0 ? 'any minute now' : `in ${countdown(idle.next.at, now).text}`;
  const what = idle.next.action === 'suspend' ? 'suspended' : 'shut down';
  return (
    <div className="mt-4">
      <InfoNote tone={soon ? 'warn' : 'info'}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            {idle.idleDays > 0 ? `No use seen for ${idle.idleDays} day${idle.idleDays === 1 ? '' : 's'}. ` : ''}
            The lab will be {what} for inactivity {when} unless it is used.
          </span>
          {canKeep && (
            <button
              className="btn-secondary"
              onClick={() => void run(() => api.post(`/api/labs/${lab.id}/activity`, { kind: 'keep-running' }), 'Idle timer restarted').then(onChanged)}
            >
              Keep running
            </button>
          )}
        </div>
      </InfoNote>
    </div>
  );
}
