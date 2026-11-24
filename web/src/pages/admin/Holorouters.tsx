import { IdleStagesEditor, describeIdle, type IdleStages } from '../../components/IdleStages';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CloudDownload,
  Download,
  ExternalLink,
  Import,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Router as RouterIcon,
  Trash2,
  Unlink,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/app-context';
import { useApi } from '../../lib/hooks';
import { dateTime, relativeTime } from '../../lib/format';
import type { CapacityProfile, Holorouter, HolorouterStatus, Job, Subnet, VCenterCert, VCenterInventory } from '../../lib/types';
import { JobConsole } from '../../components/JobConsole';
import { RouterStagingPanel, StagePicker } from '../../components/Staging';
import { ConfirmDialog, CopyButton, EmptyState, ErrorNote, Field, InfoNote, Modal, PageHeader, Spinner, Toggle } from '../../components/ui';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const statusStyle: Record<HolorouterStatus, { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  attention: { label: 'Needs attention', cls: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  onboarding: { label: 'Onboarding', cls: 'bg-blue-500/15 text-blue-300 ring-blue-500/30' },
  deploying: { label: 'Deploying', cls: 'bg-blue-500/15 text-blue-300 ring-blue-500/30' },
  offline: { label: 'Offline', cls: 'bg-red-500/15 text-red-300 ring-red-500/30' },
  error: { label: 'Error', cls: 'bg-red-500/15 text-red-300 ring-red-500/30' },
  removing: { label: 'Removing', cls: 'bg-slate-500/15 text-slate-300 ring-slate-500/30' },
};

export function RouterStatusBadge({ status }: { status: HolorouterStatus }) {
  const s = statusStyle[status] ?? statusStyle.error;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${s.cls}`}>{s.label}</span>;
}

const busy = (s: HolorouterStatus) => ['onboarding', 'deploying', 'removing'].includes(s);

function Checks({ router }: { router: Holorouter }) {
  if (!router.blockers.length && !router.warnings.length) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-300">
        <CheckCircle2 className="size-3.5" /> All checks passed
      </p>
    );
  }
  return (
    <ul className="space-y-1 text-xs">
      {router.blockers.map((b) => (
        <li key={b} className="flex gap-1.5 text-red-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {b}
        </li>
      ))}
      {router.warnings.map((w) => (
        <li key={w} className="flex gap-1.5 text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {w}
        </li>
      ))}
    </ul>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="label-caps">{label}</div>
      <div className="mt-0.5 text-sm text-slate-200">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

interface RouterList {
  holorouters: Holorouter[];
  publicKey: string;
  webtopPasswordSet: boolean;
}

export function Holorouters() {
  const { data, reload } = useApi<RouterList>('/api/admin/holorouters', { interval: 10_000 });
  const profiles = useApi<{ profiles: CapacityProfile[] }>('/api/admin/profiles');
  const [dialog, setDialog] = useState<null | 'deploy' | 'import'>(null);
  const [job, setJob] = useState<string | null>(null);
  if (!data) return <Spinner className="mx-auto size-6" />;
  const noProfiles = profiles.data && profiles.data.profiles.length === 0;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Holorouters"
        subtitle="Each Holorouter owns one network slot and runs one lab. Add routers to add lab capacity."
        actions={
          <>
            <button className="btn-secondary" onClick={() => setDialog('import')}>
              <Import className="size-4" /> Import existing
            </button>
            <button className="btn-primary" disabled={Boolean(noProfiles)} onClick={() => setDialog('deploy')}>
              <Plus className="size-4" /> Deploy new
            </button>
          </>
        }
      />
      {noProfiles && (
        <InfoNote>
          To deploy new Holorouters, create a <Link className="text-blue-300 hover:underline" to="/admin/profiles">capacity profile</Link>{' '}
          first: it says where a new Holorouter and its lab's hosts go in vCenter. Your first router can be imported without one.
        </InfoNote>
      )}
      {!data.webtopPasswordSet && (
        <InfoNote tone="warn">
          Lab owners reach their lab through their Holorouter's webtop. Set the webtop password in{' '}
          <Link className="text-blue-300 hover:underline" to="/admin/settings">Settings → Holorouters</Link> so the portal can show it to them.
        </InfoNote>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.holorouters.map((r) => (
          <Link key={r.id} to={`/admin/holorouters/${r.id}`} className="panel block p-5 transition hover:border-ink-500">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <RouterIcon className="size-4 text-blue-300" />
                  <h3 className="truncate font-semibold text-white">{r.name}</h3>
                </div>
                <div className="mt-0.5 font-mono text-xs text-slate-400">{r.mgmtIp ?? r.address}</div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <RouterStatusBadge status={r.status} />
                {r.hostsPortal && <span className="text-[11px] text-slate-400">Also runs the portal</span>}
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Fact label="Slot">
                {r.slot} · <span className="font-mono text-xs">{r.network[0]?.cidr}</span>
              </Fact>
              <Fact label="Lab">
                {r.lab ? (
                  <span className="text-blue-300">{r.lab.name}</span>
                ) : (
                  <span className="text-slate-400">Free</span>
                )}
              </Fact>
              <Fact label="Profile">{r.profile?.name ?? 'Configuration placement'}</Fact>
              <Fact label="Holodeck">{r.holodeckVersion ?? '—'}</Fact>
              <div className="col-span-2">
                <Fact label="Staged versions">
                  {r.stagingJobId ? (
                    <span className="flex items-center gap-1.5 text-blue-300"><Spinner className="size-3" /> Staging…</span>
                  ) : (
                    <span className="font-mono text-xs">
                      {r.staging?.versions.filter((v) => v.status === 'ready').map((v) => v.version).join(', ') || <span className="font-sans text-amber-300">None — labs can't be placed here</span>}
                    </span>
                  )}
                </Fact>
              </div>
            </div>
            {(
              <div className="mt-4 border-t border-ink-700 pt-3">
                {busy(r.status) ? (
                  <p className="flex items-center gap-2 text-xs text-blue-300">
                    <Spinner className="size-3.5" /> {r.status === 'deploying' ? 'Deploying from the OVA…' : r.status === 'removing' ? 'Removing…' : 'Checking the router…'}
                  </p>
                ) : r.status === 'error' ? (
                  <p className="text-xs text-red-300">{r.error}</p>
                ) : (
                  <Checks router={r} />
                )}
              </div>
            )}
          </Link>
        ))}
      </div>

      {job && <JobConsole jobId={job} height="h-72" onFinished={() => void reload()} />}

      <details className="panel p-5 text-sm">
        <summary className="cursor-pointer text-slate-300">Portal SSH key</summary>
        <p className="mt-3 text-slate-400">
          The portal manages secondary Holorouters over SSH with this key. Importing or deploying a router installs it in root's
          authorized_keys; the root password is used once and not stored.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="block flex-1 overflow-x-auto rounded-lg bg-ink-950 p-2 font-mono text-xs whitespace-nowrap text-slate-300">{data.publicKey}</code>
          <CopyButton text={data.publicKey} />
        </div>
      </details>

      {dialog === 'import' && profiles.data && (
        <ImportDialog profiles={profiles.data.profiles} onClose={() => setDialog(null)} onStarted={(id) => { setJob(id); void reload(); }} />
      )}
      {dialog === 'deploy' && profiles.data && (
        <DeployDialog profiles={profiles.data.profiles} onClose={() => setDialog(null)} onStarted={(id) => { setJob(id); void reload(); }} />
      )}
    </div>
  );
}

function ProfileSelect({ profiles, value, onChange, allowNone }: { profiles: CapacityProfile[]; value: number | null; onChange: (id: number) => void; allowNone?: boolean }) {
  return (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      {allowNone && <option value={0}>None: serve any configuration, with its own placement</option>}
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} — {p.cluster} / {p.datastore}
        </option>
      ))}
    </select>
  );
}

interface ScannedKey {
  type: string;
  fingerprint: string;
}

function ImportDialog({ profiles, onClose, onStarted }: { profiles: CapacityProfile[]; onClose: () => void; onStarted: (job: string) => void }) {
  const run = useAction();
  const [form, setForm] = useState({ address: '', password: '', name: '', profileId: profiles[0]?.id ?? 0, stageVersions: [] as string[] });
  const [scan, setScan] = useState<{ address: string; keys: ScannedKey[] } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busyNow, setBusy] = useState(false);
  const key = scan && scan.address === form.address ? scan.keys[0] : null;
  const doScan = async () => {
    setScanning(true);
    setConfirmed(false);
    const r = await run(() => api.post<{ address: string; keys: ScannedKey[] }>('/api/admin/holorouters/scan-host-key', { address: form.address }));
    setScanning(false);
    if (r) setScan(r);
  };
  const submit = async () => {
    setBusy(true);
    const r = await run(
      () => api.post<{ job: Job }>('/api/admin/holorouters/import', { ...form, profileId: form.profileId || null, name: form.name || undefined, hostKeyFingerprint: key!.fingerprint }),
      'Import started',
    );
    setBusy(false);
    if (r) {
      onStarted(r.job.id);
      onClose();
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Import an existing Holorouter"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busyNow || !form.address || !form.password || !key || !confirmed} onClick={submit}>
            {busyNow ? <Spinner /> : <Import className="size-4" />} Import
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-400">
          The portal signs in once with the root password to install its SSH key, then checks the router: Holodeck version, Kubernetes,
          webtop, trunk NICs, vCenter reachability, and that no earlier Holodeck instance or network configuration is left on it.
        </p>
        <Field label="Hostname or IP address">
          <div className="flex gap-2">
            <input className="input font-mono" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value.trim() })} placeholder="192.0.2.81" />
            <button className="btn-secondary shrink-0" disabled={!form.address || scanning} onClick={doScan}>
              {scanning && <Spinner />} Scan host key
            </button>
          </div>
        </Field>
        {key && (
          <div className="rounded-lg border border-ink-600 bg-ink-900 p-3 text-sm">
            <div className="text-slate-400">SSH host key offered by {scan!.address}:</div>
            <div className="mt-1 font-mono break-all text-slate-100">
              {key.type} {key.fingerprint}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Compare it with the router's own console, where <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> prints it. The root
              password is only sent to a router presenting this key.
            </p>
            <div className="mt-2">
              <Toggle checked={confirmed} onChange={setConfirmed} label="This is the fingerprint the router shows" />
            </div>
          </div>
        )}
        <Field label="Root password" help="Used once to install the portal's key; not stored.">
          <input className="input" type="password" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label="Display name" help="Optional; defaults to the router's hostname.">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field
          label="Capacity profile"
          help="Must match the port groups the router's NICs are attached to; the router then takes labs of the profile's configuration only, placed by the profile. Without one (e.g. your first router, before any configuration exists) it takes any configuration's labs, placed by the configuration."
        >
          <ProfileSelect profiles={profiles} value={form.profileId} allowNone onChange={(profileId) => setForm({ ...form, profileId })} />
        </Field>
        <Field label="Stage installation files" help="Copied from a Holorouter that has them once the router passes its checks; also possible later from the router's page.">
          <StagePicker value={form.stageVersions} onChange={(stageVersions) => setForm({ ...form, stageVersions })} />
        </Field>
      </div>
    </Modal>
  );
}

function DeployDialog({ profiles, onClose, onStarted }: { profiles: CapacityProfile[]; onClose: () => void; onStarted: (job: string) => void }) {
  const run = useAction();
  const [form, setForm] = useState({
    profileId: profiles[0]?.id ?? 0,
    vmName: '',
    hostname: '',
    ip: '',
    prefix: 24,
    gateway: '',
    dnsServer: '',
    dnsDomain: '',
    ntpServer: '',
    password: '',
    confirm: '',
    gitops: false,
    stageVersions: [] as string[],
  });
  const [busyNow, setBusy] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;
  const ok = form.hostname && form.ip && form.gateway && form.dnsServer && form.dnsDomain && form.ntpServer && form.password.length >= 8 && form.password === form.confirm;
  const submit = async () => {
    setBusy(true);
    const { confirm: _c, ...body } = form;
    const r = await run(() => api.post<{ job: Job }>('/api/admin/holorouters/deploy', { ...body, vmName: form.vmName.trim() || form.hostname }), 'Deployment started');
    setBusy(false);
    if (r) {
      onStarted(r.job.id);
      onClose();
    }
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Deploy a new Holorouter"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busyNow || !ok} onClick={submit}>
            {busyNow ? <Spinner /> : <CloudDownload className="size-4" />} Deploy
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Capacity profile" className="sm:col-span-2" help="vCenter placement for the router VM: datastore, management network and both trunk port groups.">
          <ProfileSelect profiles={profiles} value={form.profileId} onChange={(profileId) => set({ profileId })} />
        </Field>
        {(() => {
          const sel = profiles.find((p) => p.id === form.profileId);
          if (sel?.license && !sel.license.writable) {
            return (
              <div className="sm:col-span-2">
                <InfoNote tone="warn">
                  The ESXi host of this profile doesn’t accept deployments through its API ({sel.license.evaluation ? 'its evaluation period has ended' : 'free ESXi licence'}).
                  Deploy the Holorouter OVA on the host yourself (VM console or ESXi Host Client), then add it with <strong>Import existing</strong>.
                </InfoNote>
              </div>
            );
          }
          if (!sel?.vcenterCertificate) {
            return (
              <div className="sm:col-span-2">
                <InfoNote tone="warn">
                  This capacity profile has no approved {sel?.targetType === 'esxi' ? 'ESXi host' : 'vCenter'} certificate, so the deployment would be
                  refused. Approve it under <Link className="underline" to="/admin/profiles">Capacity profiles</Link> first.
                </InfoNote>
              </div>
            );
          }
          if (sel.license?.evaluation && sel.license.hoursLeft !== null && sel.license.hoursLeft < 7 * 24) {
            return (
              <div className="sm:col-span-2">
                <InfoNote tone="warn">
                  The ESXi host’s evaluation ends in about {Math.max(1, Math.round(sel.license.hoursLeft / 24))} day(s); after that, routers must be
                  deployed by hand and imported.
                </InfoNote>
              </div>
            );
          }
          return null;
        })()}
        <Field label="Hostname">
          <input className="input font-mono" value={form.hostname} onChange={(e) => set({ hostname: e.target.value.trim() })} placeholder="holorouter2" />
        </Field>
        <Field label="VM name" help="Defaults to the hostname. Spaces and . - _ ( ) are allowed.">
          <input className="input font-mono" value={form.vmName} maxLength={80} onChange={(e) => set({ vmName: e.target.value.replace(/^\s+/, '') })} placeholder={form.hostname || 'holorouter2'} />
        </Field>
        <Field label="Management IP">
          <input className="input font-mono" value={form.ip} onChange={(e) => set({ ip: e.target.value.trim() })} placeholder="192.0.2.81" />
        </Field>
        <Field label="Prefix length">
          <input className="input font-mono" type="number" min={8} max={30} value={form.prefix} onChange={(e) => set({ prefix: Number(e.target.value) })} />
        </Field>
        <Field label="Gateway">
          <input className="input font-mono" value={form.gateway} onChange={(e) => set({ gateway: e.target.value.trim() })} placeholder="192.0.2.1" />
        </Field>
        <Field label="DNS server">
          <input className="input font-mono" value={form.dnsServer} onChange={(e) => set({ dnsServer: e.target.value.trim() })} placeholder="192.0.2.10" />
        </Field>
        <Field label="DNS domain">
          <input className="input font-mono" value={form.dnsDomain} onChange={(e) => set({ dnsDomain: e.target.value.trim() })} placeholder="example.com" />
        </Field>
        <Field label="NTP server">
          <input className="input font-mono" value={form.ntpServer} onChange={(e) => set({ ntpServer: e.target.value.trim() })} placeholder="pool.ntp.org" />
        </Field>
        <Field label="Root password" help="At least 8 characters. Used once to install the portal's key; not stored.">
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => set({ password: e.target.value })} />
        </Field>
        <Field label="Confirm password">
          <input className={`input ${mismatch ? 'border-red-500' : ''}`} type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => set({ confirm: e.target.value })} />
        </Field>
        <div className="space-y-3 sm:col-span-2">
          <Toggle checked disabled onChange={() => undefined} label="Enable SSH" help="Required: the portal runs Holodeck on the router over SSH." />
          <Toggle checked disabled onChange={() => undefined} label="Enable the webtop UI" help="Required: it's the lab's jump host for users." />
          <Toggle checked={form.gitops} onChange={(gitops) => set({ gitops })} label="Enable GitOps" help="GitLab on the router; optional." />
        </div>
        <Field label="Stage installation files" className="sm:col-span-2" help="Copied from a Holorouter that has them once the new router passes its checks; also possible later from the router's page.">
          <StagePicker value={form.stageVersions} onChange={(stageVersions) => set({ stageVersions })} />
        </Field>
        <InfoNote>
          The OVA is streamed from the depot (Settings → Holorouters). The first boot installs Kubernetes and the webtop, which takes
          a while; the job waits for it, installs the portal's key and runs the router checks.
        </InfoNote>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

interface RouterDetailData {
  holorouter: Holorouter;
  services: { name: string; fqdn: string; address: string }[];
  subnets: { a: Subnet[]; b: Subnet[] };
  logs: { name: string; size: number; modified: string }[];
}

export function HolorouterDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, reload } = useApi<RouterDetailData>(`/api/admin/holorouters/${id}`, { interval: 15_000 });
  const configs = useApi<{ configs: { id: number; name: string }[] }>('/api/admin/configs');
  const profiles = useApi<{ profiles: CapacityProfile[] }>('/api/admin/profiles');
  const run = useAction();
  const [job, setJob] = useState<string | null>(null);
  const [configId, setConfigId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<null | 'reset-state' | 'detach' | 'delete' | 'forget'>(null);
  const [logView, setLogView] = useState<{ name: string; text: string } | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  useEffect(() => {
    if (data?.holorouter.lastJobId && busy(data.holorouter.status)) setJob((j) => j ?? data.holorouter.lastJobId);
  }, [data?.holorouter.lastJobId, data?.holorouter.status]);
  if (!data) return <Spinner className="mx-auto size-6" />;
  const r = data.holorouter;
  const cfg = configId ?? configs.data?.configs[0]?.id ?? null;
  const base = `/api/admin/holorouters/${r.id}`;
  const command = async (action: string) => {
    if (!cfg) return;
    const res = await run(() => api.post<{ job: Job }>(`${base}/command`, { configId: cfg, action }));
    if (res) setJob(res.job.id);
  };
  const check = async () => {
    const res = await run(() => api.post<{ job: Job }>(`${base}/check`), 'Check started');
    if (res) {
      setJob(res.job.id);
      void reload();
    }
  };
  const detach = async (deleteVm: boolean) => {
    const res = await run(() => api.post<{ job: Job }>(`${base}/detach`, { deleteVm, confirm: r.name }), deleteVm ? 'Removing and deleting' : 'Detaching');
    if (res) {
      setJob(res.job.id);
      void reload();
    }
  };
  const insp = r.inspection;
  const dns = data.services.find((s) => s.name === 'dns');
  return (
    <div className="space-y-6">
      <Link to="/admin/holorouters" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">
        <ArrowLeft className="size-4" /> Holorouters
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {rename === null ? (
              <>
                {r.name}
                <button className="btn-ghost p-1" title="Rename" onClick={() => setRename(r.name)}>
                  <Pencil className="size-3.5" />
                </button>
              </>
            ) : (
              <form
                className="flex items-center gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await run(() => api.patch(base, { name: rename }), 'Renamed');
                  if (ok) {
                    setRename(null);
                    void reload();
                  }
                }}
              >
                <input className="input w-64" value={rename} onChange={(e) => setRename(e.target.value)} autoFocus />
                <button className="btn-primary">Save</button>
                <button type="button" className="btn-ghost" onClick={() => setRename(null)}>Cancel</button>
              </form>
            )}
            <RouterStatusBadge status={r.status} />
          </span>
        }
        subtitle={`${r.origin === 'deployed' ? 'Deployed by the portal' : 'Imported'}${r.hostsPortal ? ' · also runs the portal' : ''} · ${r.mgmtIp ?? r.address}`}
        actions={
          <>
            {r.webtopUrl && (
              <a className="btn-secondary" href={r.webtopUrl} target="_blank" rel="noreferrer">
                <Monitor className="size-4" /> Webtop
              </a>
            )}
            {(
              <button className="btn-secondary" disabled={busy(r.status) && r.status !== 'onboarding'} onClick={check}>
                <RefreshCw className="size-4" /> Check now
              </button>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="panel space-y-4 p-5 lg:col-span-2">
          <h3 className="label-caps">Overview</h3>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Fact label="Network slot">{r.slot}</Fact>
            <Fact label="Site A">
              <span className="font-mono text-xs">{r.network[0]?.cidr} · VLAN {r.network[0]?.vlanStart}–{r.network[0]?.vlanEnd}</span>
            </Fact>
            <Fact label="Site B (reserved)">
              <span className="font-mono text-xs">{r.network[1]?.cidr} · VLAN {r.network[1]?.vlanStart}–{r.network[1]?.vlanEnd}</span>
            </Fact>
            <Fact label="Lab">
              {r.lab ? <Link className="text-blue-300 hover:underline" to={`/labs/${r.lab.id}`}>{r.lab.name}</Link> : <span className="text-slate-400">Free</span>}
            </Fact>
            <Fact label="Holodeck">{r.holodeckVersion ?? '—'}</Fact>
            <Fact label="Last seen">{r.lastSeenAt ? relativeTime(r.lastSeenAt) : '—'}</Fact>
            {(
              <Fact label="SSH host key">
                <span className="font-mono text-xs break-all">{r.hostKey ?? 'not recorded'}</span>
                {r.hostKey && (
                  <div className="mt-2 space-y-2">
                    {r.hostKeyShared && (
                      <InfoNote tone="warn">
                        This is the key every Holorouter OVA ships with, so it doesn’t identify this router. Give it its own key (open
                        sessions and labs are not interrupted).
                      </InfoNote>
                    )}
                    <button
                      className={r.hostKeyShared ? 'btn-secondary' : 'btn-ghost text-xs'}
                      disabled={busy(r.status)}
                      onClick={async () => {
                        const res = await run(() => api.post<{ job: { id: string } }>(`${base}/renew-host-key`), 'Renewing the SSH host key');
                        if (res) {
                          setJob(res.job.id);
                          void reload();
                        }
                      }}
                    >
                      Renew SSH host key
                    </button>
                  </div>
                )}
              </Fact>
            )}
            {insp && (
              <>
                <Fact label="Size">{insp.cpus} vCPU · {insp.memoryGB} GB · {insp.diskFreeGB} GB free</Fact>
                <Fact label="Kubernetes">{insp.kubernetes?.reachable ? `${insp.kubernetes.pods} pods` : 'unreachable'}</Fact>
                <Fact label="NICs">{insp.nics?.map((n) => `${n.name} ${n.present ? n.state : 'missing'}`).join(' · ')}</Fact>
              </>
            )}
          </div>
          {r.error && <ErrorNote>{r.error}</ErrorNote>}
          <Checks router={r} />
          {insp?.checkedAt && <p className="text-xs text-slate-500">Checked {dateTime(insp.checkedAt)}</p>}
        </div>

        <div className="panel space-y-4 p-5">
          <h3 className="label-caps">Placement</h3>
          {(
            <Field
              label="Capacity profile"
              help={
                r.lab
                  ? 'Can change once the router has no lab.'
                  : r.profile
                    ? 'Where this router’s lab hosts are placed.'
                    : 'None: labs use their configuration’s own placement. Choose a profile to place them by profile (also needed to delete the VM).'
              }
            >
              <select
                className="input"
                disabled={Boolean(r.lab)}
                value={r.profile?.id ?? ''}
                onChange={async (e) => {
                  const ok = await run(() => api.patch(base, { profileId: Number(e.target.value) }), 'Profile updated');
                  if (ok) void reload();
                }}
              >
                {!r.profile && <option value="">Configuration placement</option>}
                {profiles.data?.profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
          )}
          {r.webtop.gatewayEnabled && (
            <div className="space-y-2 border-t border-ink-700 pt-4">
              <h3 className="label-caps">Webtop access</h3>
              <select
                className="input"
                value={r.webtop.mode ?? ''}
                onChange={async (e) => {
                  const webtopMode = e.target.value === '' ? null : e.target.value;
                  const ok = await run(() => api.patch(base, { webtopMode }), 'Webtop access updated');
                  if (ok) void reload();
                }}
              >
                <option value="">Default (Settings → Holorouters)</option>
                <option value="direct">Direct: link to the router, password shown</option>
                <option value="portal">Through the portal</option>
                {!r.hostsPortal && <option value="portal-only">Through the portal only</option>}
              </select>
              <p className="text-xs text-slate-400">
                {r.webtop.effectiveMode === 'direct' && 'Users open the router’s webtop directly with the shared login.'}
                {r.webtop.effectiveMode === 'portal' &&
                  `Opens through the portal (port ${r.webtop.gatewayPort}) for the lab's owner and administrators. The router's own webtop still answers, for anyone who knows the shared password.`}
                {r.webtop.effectiveMode === 'portal-only' &&
                  `Opens through the portal (port ${r.webtop.gatewayPort}) only. The portal keeps the router's webtop ports and its web services (80/443) closed on the management network${r.webtop.firewall === 'closed' ? ' (closed now)' : ' (closing at the next check)'}.`}
              </p>
            </div>
          )}
          <RouterIdlePolicy router={r} onSaved={() => void reload()} />
          {(
            <div className="space-y-2 border-t border-ink-700 pt-4">
              <h3 className="label-caps">Remove</h3>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" disabled={busy(r.status) || Boolean(r.lab)} onClick={() => setConfirm('detach')}>
                  <Unlink className="size-4" /> Detach
                </button>
                <button className="btn-danger" disabled={busy(r.status) || Boolean(r.lab)} onClick={() => setConfirm('delete')}>
                  <Trash2 className="size-4" /> Detach &amp; delete VM
                </button>
                {['error', 'offline', 'onboarding', 'attention'].includes(r.status) && !r.lab && (
                  <button className="btn-ghost text-xs" onClick={() => setConfirm('forget')}>Forget without contacting it</button>
                )}
              </div>
              {r.lab && <p className="text-xs text-slate-500">Remove the router's lab first.</p>}
            </div>
          )}
        </div>
      </div>

      {job && <JobConsole jobId={job} height="h-72" onFinished={() => void reload()} />}

      {['ready', 'attention'].includes(r.status) && <RouterStagingPanel router={r} onChanged={() => void reload()} />}

      {['ready', 'attention'].includes(r.status) && (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="panel p-5">
              <h3 className="label-caps mb-3">Services</h3>
              {data.services.length === 0 ? (
                <p className="text-sm text-slate-400">No services yet; Holodeck installs them with the router's first lab.</p>
              ) : (
                <table className="table-base">
                  <tbody>
                    {data.services.map((s) => (
                      <tr key={s.name}>
                        <td className="text-slate-200">{s.name}</td>
                        <td className="font-mono text-xs">
                          <a className="text-blue-300 hover:underline" href={`https://${s.fqdn}`} target="_blank" rel="noreferrer">{s.fqdn}</a>
                        </td>
                        <td className="font-mono text-xs text-slate-400">{s.address}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {dns && (
                <p className="mt-3 text-xs text-slate-500">
                  DNS records are managed in Technitium (
                  <a className="text-blue-300 hover:underline" href={`https://${dns.fqdn}`} target="_blank" rel="noreferrer">
                    {dns.fqdn} <ExternalLink className="inline size-3" />
                  </a>
                  ). Holodeck's own DNS cmdlets target the retired dnsmasq setup and don't work on 9.1 Holorouters.
                </p>
              )}
            </div>

            <div className="panel space-y-4 p-5">
              <h3 className="label-caps">Holodeck commands</h3>
              <Field label="Run against configuration">
                <select className="input" value={cfg ?? ''} onChange={(e) => setConfigId(Number(e.target.value))}>
                  {configs.data?.configs.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" onClick={() => command('bgp')}>Get-HoloDeckBGPConfig</button>
                <button className="btn-secondary" onClick={() => command('services')}>Get-HolorouterServices</button>
              </div>
              <div className="border-t border-ink-700 pt-4">
                <InfoNote tone="warn">
                  Only allowed when this router has no lab. Reset-HoloRouter is not available here: it uninstalls GitLab, Authentik,
                  Vault, DNS and Kubernetes on the Holorouter, deletes their data and reboots it.
                </InfoNote>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="btn-danger" disabled={Boolean(r.lab)} onClick={() => setConfirm('reset-state')}>
                    <RotateCcw className="size-4" /> Reset-HoloDeckState
                  </button>
                </div>
              </div>
            </div>
          </div>

          {(['a', 'b'] as const).map((site) =>
            data.subnets[site].length ? (
              <div key={site} className="panel overflow-x-auto p-5">
                <h3 className="label-caps mb-3">Configured subnets — site {site.toUpperCase()}</h3>
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
                    {data.subnets[site].map((s) => (
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
              </div>
            ) : null,
          )}

          <div className="panel p-5">
            <h3 className="label-caps mb-3">Holodeck logs</h3>
            {data.logs.length === 0 && <p className="text-sm text-slate-400">No Holodeck logs on this router yet.</p>}
            <table className="table-base">
              <tbody>
                {data.logs.map((l) => (
                  <tr key={l.name}>
                    <td className="font-mono text-xs">{l.name}</td>
                    <td className="text-slate-400">{(l.size / 1024).toFixed(0)} KB</td>
                    <td className="text-slate-400">{dateTime(l.modified)}</td>
                    <td className="text-right whitespace-nowrap">
                      <button
                        className="btn-ghost px-2 py-1 text-xs"
                        onClick={async () => {
                          const res = await fetch(`${base}/logs/${encodeURIComponent(l.name)}?tail=65536`);
                          setLogView({ name: l.name, text: await res.text() });
                        }}
                      >
                        Tail
                      </button>
                      <a className="btn-ghost px-2 py-1 text-xs" href={`${base}/logs/${encodeURIComponent(l.name)}?tail=${50 * 1024 * 1024}`} download={l.name}>
                        <Download className="size-3.5" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {logView && (
              <div className="mt-4">
                <div className="mb-2 font-mono text-xs text-slate-400">{logView.name} (last 64 KB)</div>
                <pre className="h-96 overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-xs whitespace-pre-wrap text-slate-300">{logView.text}</pre>
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirm === 'reset-state'}
        onClose={() => setConfirm(null)}
        danger
        title="Reset Holodeck state?"
        confirmLabel="Reset"
        message="Clears Holodeck’s deployment state on this router so the next deployment starts fresh."
        onConfirm={() => command('reset-state')}
      />
      <ConfirmDialog
        open={confirm === 'detach'}
        onClose={() => setConfirm(null)}
        title={`Detach ${r.name}?`}
        confirmLabel="Detach"
        requireText={r.name}
        message="The portal removes its SSH key from the router and stops using it. The VM keeps running; you can import it again later."
        onConfirm={() => detach(false)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        danger
        title={`Detach and delete ${r.name}?`}
        confirmLabel="Delete VM"
        requireText={r.name}
        message={`The portal removes its key, then powers off and permanently deletes the VM ${r.vmName ?? `with IP ${r.mgmtIp ?? r.address}`} in vCenter. This cannot be undone.`}
        onConfirm={() => detach(true)}
      />
      <ConfirmDialog
        open={confirm === 'forget'}
        onClose={() => setConfirm(null)}
        title={`Forget ${r.name}?`}
        confirmLabel="Forget"
        message="Removes the router from the portal without contacting it (its slot becomes free). The portal's key may remain in its authorized_keys."
        onConfirm={async () => {
          const ok = await run(() => api.del(base), 'Router forgotten');
          if (ok) navigate('/admin/holorouters');
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capacity profiles
// ---------------------------------------------------------------------------

export function CapacityProfiles() {
  const { data, reload } = useApi<{ profiles: CapacityProfile[] }>('/api/admin/profiles');
  const [cert, setCert] = useState<CapacityProfile | null>(null);
  const run = useAction();
  const [editing, setEditing] = useState<CapacityProfile | 'new' | null>(null);
  const [remove, setRemove] = useState<CapacityProfile | null>(null);
  if (!data) return <Spinner className="mx-auto size-6" />;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Capacity profiles"
        subtitle="Where Holorouters and their labs' nested hosts go in vCenter: datastore, management network and the trunk port groups for both sites."
        actions={
          <button className="btn-primary" onClick={() => setEditing('new')}>
            <Plus className="size-4" /> New profile
          </button>
        }
      />
      {data.profiles.length === 0 ? (
        <EmptyState icon={<RouterIcon />} title="No capacity profiles yet">
          A profile is needed before deploying or importing a Holorouter.
        </EmptyState>
      ) : (
        <div className="panel overflow-x-auto p-2">
          <table className="table-base">
            <thead>
              <tr>
                <th>Name</th>
                <th>vCenter</th>
                <th>Cluster / pool</th>
                <th>Datastore</th>
                <th>Management</th>
                <th>Trunk A / B</th>
                <th>Used by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.profiles.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium text-white">{p.name}</td>
                  <td className="text-xs">
                    {p.vcenter}
                    <div className="text-slate-500">{p.configName}</div>
                    <button className="mt-1 text-left hover:underline" onClick={() => setCert(p)}>
                      {p.vcenterCertificate ? (
                        <span className="text-emerald-300">Certificate approved</span>
                      ) : (
                        <span className="text-amber-300">Certificate not approved</span>
                      )}
                    </button>
                  </td>
                  <td className="text-xs">
                    {p.datacenter} / {p.cluster}
                    {p.resourcePool && <div className="text-slate-500">{p.resourcePool}</div>}
                  </td>
                  <td className="text-xs">{p.datastore}</td>
                  <td className="text-xs">{p.mgmtNetwork}</td>
                  <td className="text-xs">
                    {p.trunkA}
                    <div className="text-slate-500">{p.trunkB}</div>
                  </td>
                  <td className="text-xs">{p.routers.map((r) => r.name).join(', ') || '—'}</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost px-2 py-1" onClick={() => setEditing(p)} title="Edit">
                      <Pencil className="size-3.5" />
                    </button>
                    <button className="btn-ghost px-2 py-1" disabled={p.routers.length > 0} onClick={() => setRemove(p)} title="Delete">
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cert && <VcenterCertDialog profile={cert} onClose={() => setCert(null)} onChanged={() => void reload()} />}
      {editing && <ProfileEditor profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
      <ConfirmDialog
        open={Boolean(remove)}
        onClose={() => setRemove(null)}
        danger
        title={`Delete profile ${remove?.name}?`}
        confirmLabel="Delete"
        message="Routers no longer use it, so nothing else changes."
        onConfirm={async () => {
          const ok = await run(() => api.del(`/api/admin/profiles/${remove!.id}`), 'Profile deleted');
          if (ok) void reload();
        }}
      />
    </div>
  );
}

/** Shows the certificate the profile's vCenter presents and lets an administrator approve it. */
function VcenterCertDialog({ profile, onClose, onChanged }: { profile: CapacityProfile; onClose: () => void; onChanged: () => void }) {
  const run = useAction();
  const { data, error } = useApi<{ current: VCenterCert; approved: VCenterCert | null }>(`/api/admin/profiles/${profile.id}/vcenter-certificate`);
  const [busy, setBusy] = useState(false);
  const cur = data?.current;
  const approved = data?.approved ?? null;
  const same = Boolean(cur && approved && cur.sha256 === approved.sha256);
  // Approvals made before strict verification existed lack the CA: approving the same certificate again adds it.
  const needsReapproval = same && !approved?.caPem && profile.targetType !== 'esxi';
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    const ok = await run(fn, msg);
    setBusy(false);
    if (ok) {
      onChanged();
      onClose();
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`${profile.targetType === 'esxi' ? 'ESXi host' : 'vCenter'} certificate — ${profile.name}`}
      footer={
        <>
          {approved && (
            <button className="btn-ghost mr-auto" disabled={busy} onClick={() => act(() => api.del(`/api/admin/profiles/${profile.id}/vcenter-certificate`), 'Approval cleared')}>
              Clear approval
            </button>
          )}
          <button className="btn-ghost" onClick={onClose}>Close</button>
          <button
            className="btn-primary"
            disabled={busy || !cur || (same && !needsReapproval)}
            onClick={() => act(() => api.post(`/api/admin/profiles/${profile.id}/vcenter-certificate`, { sha256: cur!.sha256 }), 'Certificate approved')}
          >
            {busy && <Spinner />} {needsReapproval ? 'Approve again' : 'Approve this certificate'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-slate-400">
          Router deployments with this profile need an approved certificate: they check that vCenter still presents it before signing in, and
          sign in only if its certificate chains to vCenter's own certificate authority (saved with the approval). Compare
          the SHA-256 with the certificate in the vSphere Client (or ask the vCenter administrator) before approving.
        </p>
        {error && <ErrorNote>{error}</ErrorNote>}
        {!cur && !error && <Spinner className="mx-auto size-5" />}
        {cur && (
          <div className="rounded-lg border border-ink-600 bg-ink-900 p-3">
            <div className="label-caps mb-1">{cur.host} presents now</div>
            <div className="text-xs text-slate-400">Subject: {cur.subject}</div>
            <div className="text-xs text-slate-400">Issuer: {cur.issuer}</div>
            <div className="text-xs text-slate-400">Valid until: {cur.validTo}</div>
            <div className="mt-1 font-mono text-xs break-all text-slate-100">SHA-256 {cur.sha256}</div>
          </div>
        )}
        {approved && !same && (
          <InfoNote tone="warn">
            The approved certificate is different (SHA-256 <span className="font-mono break-all">{approved.sha256}</span>), so deployments with this profile
            stop until the new one is approved. Approve only if the change is expected, e.g. a renewed certificate.
          </InfoNote>
        )}
        {profile.targetType === 'esxi' && (
          <InfoNote>
            A standalone ESXi host usually has a self-signed certificate. Deployments check that the host still presents the approved one before
            signing in; the stricter certificate-authority check applies to vCenter only.
          </InfoNote>
        )}
        {same && profile.targetType === 'esxi' && <InfoNote>This certificate is approved.</InfoNote>}
        {same && !needsReapproval && profile.targetType !== 'esxi' && (
          <InfoNote>
            This certificate is approved.{' '}
            {approved?.nameMatches === false
              ? 'It is not issued for this host name, so the deployment’s vCenter sign-in is not verified strictly.'
              : 'Deployments verify their vCenter sign-in strictly.'}
          </InfoNote>
        )}
        {needsReapproval && (
          <InfoNote tone="warn">
            This certificate is approved, but the approval predates strict verification of the deployment’s vCenter sign-in. Click{' '}
            <strong>Approve again</strong> to save vCenter’s certificate authority with it.
          </InfoNote>
        )}
      </div>
    </Modal>
  );
}

function ProfileEditor({ profile, onClose, onSaved }: { profile: CapacityProfile | null; onClose: () => void; onSaved: () => void }) {
  const configs = useApi<{ configs: { id: number; name: string; configId: string }[] }>('/api/admin/configs');
  const run = useAction();
  const [form, setForm] = useState({
    name: profile?.name ?? '',
    configId: profile?.configId ?? 0,
    datacenter: profile?.datacenter ?? '',
    cluster: profile?.cluster ?? '',
    resourcePool: profile?.resourcePool ?? '',
    folder: profile?.folder ?? '',
    datastore: profile?.datastore ?? '',
    mgmtNetwork: profile?.mgmtNetwork ?? '',
    trunkA: profile?.trunkA ?? '',
    trunkB: profile?.trunkB ?? '',
  });
  const configId = form.configId || configs.data?.configs[0]?.id || 0;
  const inv = useApi<{ inventory: VCenterInventory | null }>(configId ? `/api/admin/inventory/${configId}` : null);
  const [job, setJob] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const inventory = inv.data?.inventory;
  const dc = inventory?.datacenters.find((d) => d.name === form.datacenter);
  const cluster = dc?.clusters.find((c) => c.name === form.cluster);
  const refresh = async () => {
    const r = await run(() => api.post<{ job: Job }>(`/api/admin/inventory/${configId}/refresh`));
    if (r) setJob(r.job.id);
  };
  const ok = form.name && configId && form.datacenter && form.cluster && form.datastore && form.mgmtNetwork && form.trunkA && form.trunkB;
  const save = async () => {
    const body = { ...form, configId };
    const r = await run(() => (profile ? api.put(`/api/admin/profiles/${profile.id}`, body) : api.post('/api/admin/profiles', body)), 'Profile saved');
    if (r) onSaved();
  };
  const pick = (label: string, value: string, options: { value: string; label: string }[], onChange: (v: string) => void, opts: { optional?: boolean; help?: string } = {}) => (
    <Field label={label} help={opts.help}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={!inventory}>
        <option value="">{opts.optional ? '(none)' : 'Select…'}</option>
        {value && !options.some((o) => o.value === value) && <option value={value}>{value} (not in inventory)</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </Field>
  );
  const nets = (cluster?.networks ?? []).map((n) => ({ value: n.name, label: `${n.name}${n.type === 'distributed' ? ' (dvPG)' : ''}` }));
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={profile ? `Edit ${profile.name}` : 'New capacity profile'}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!ok} onClick={save}>Save</button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Lab cluster / NFS datastore" />
        </Field>
        <Field label="vCenter or ESXi host (from configuration)" help="The portal connects with this configuration's target credentials.">
          <select className="input" value={configId} onChange={(e) => set({ configId: Number(e.target.value), datacenter: '', cluster: '' })}>
            {configs.data?.configs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          <p className="text-xs text-slate-400">
            {inventory
              ? `Inventory read ${relativeTime(inventory.fetchedAt)}${inventory.apiType === 'HostAgent' ? ' (standalone ESXi host)' : ''}.`
              : 'Read the inventory to choose placement.'}
          </p>
          <button className="btn-secondary" onClick={refresh} disabled={!configId}>
            <RefreshCw className="size-4" /> {inventory ? 'Refresh inventory' : 'Read inventory'}
          </button>
        </div>
        {job && (
          <div className="sm:col-span-2">
            <JobConsole jobId={job} height="h-48" onFinished={() => { void inv.reload(); setJob(null); }} />
          </div>
        )}
        {pick('Datacenter', form.datacenter, (inventory?.datacenters ?? []).map((d) => ({ value: d.name, label: d.name })), (v) => set({ datacenter: v, cluster: '' }))}
        {pick(
          inventory?.apiType === 'HostAgent' ? 'Host' : 'Cluster',
          form.cluster,
          (dc?.clusters ?? []).map((c) => ({ value: c.name, label: c.kind === 'host' ? `${c.name} (standalone host)` : c.name })),
          (v) => set({ cluster: v }),
        )}
        {pick('Resource pool', form.resourcePool, (cluster?.resourcePools ?? []).map((p) => ({ value: p, label: p })), (v) => set({ resourcePool: v }), { optional: true })}
        {inventory?.apiType !== 'HostAgent' &&
          pick('VM folder', form.folder, (dc?.folders ?? []).map((f) => ({ value: f, label: f })), (v) => set({ folder: v }), { optional: true, help: 'For Holorouter VMs.' })}
        {pick(
          'Datastore',
          form.datastore,
          (cluster?.datastores ?? []).map((d) => ({ value: d.name, label: `${d.name} — ${d.freeGB} of ${d.capacityGB} GB free` })),
          (v) => set({ datastore: v }),
        )}
        {pick('Management network', form.mgmtNetwork, nets, (v) => set({ mgmtNetwork: v }), { help: "The router's eth0; needs outbound access." })}
        {pick('Trunk port group — site A', form.trunkA, nets, (v) => set({ trunkA: v }), { help: "Router eth1 and the lab's nested hosts." })}
        {pick('Trunk port group — site B', form.trunkB, nets, (v) => set({ trunkB: v }), { help: 'Router eth2 (dual-site labs, later).' })}
        <div className="sm:col-span-2">
          <InfoNote>
            Trunk port groups must carry the VLANs of every slot that uses this profile (slot n, site A starts at VLAN
            {' '}(2n−1)×100; site B at 2n×100) and allow promiscuous mode, MAC changes and forged transmits as Holodeck requires.
          </InfoNote>
          {inventory?.license && !inventory.license.writable && (
            <div className="mt-3">
              <InfoNote tone="warn">
                This ESXi host doesn’t accept deployments through its API ({inventory.license.evaluation ? 'its evaluation period has ended' : 'free ESXi licence'}).
                Routers for this profile must be deployed on the host by hand and added with <strong>Import existing</strong>; labs work as usual.
              </InfoNote>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Idle labs on this router: follow the default, own stages, or never. */
function RouterIdlePolicy({ router: r, onSaved }: { router: Holorouter; onSaved: () => void }) {
  const run = useAction();
  const [mode, setMode] = useState(r.idle.policy.mode);
  const [stages, setStages] = useState<IdleStages>(
    r.idle.policy.mode === 'custom' ? { suspend: r.idle.policy.suspend, shutdown: r.idle.policy.shutdown } : { suspend: r.idle.default.suspend, shutdown: r.idle.default.shutdown },
  );
  const dirty =
    mode !== r.idle.policy.mode ||
    (mode === 'custom' && r.idle.policy.mode === 'custom' && JSON.stringify(stages) !== JSON.stringify({ suspend: r.idle.policy.suspend, shutdown: r.idle.policy.shutdown }));
  const save = async () => {
    const idlePolicy = mode === 'custom' ? { mode, ...stages } : { mode };
    const ok = await run(() => api.patch(`/api/admin/holorouters/${r.id}`, { idlePolicy }), 'Idle policy updated');
    if (ok) onSaved();
  };
  return (
    <div className="space-y-2 border-t border-ink-700 pt-4">
      <h3 className="label-caps">Idle labs</h3>
      <select className="input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
        <option value="default">Default (Settings → Leases): {describeIdle(r.idle.default)}</option>
        <option value="custom">This router's own stages</option>
        <option value="off">Never suspend or shut down for inactivity</option>
      </select>
      {mode === 'custom' && <IdleStagesEditor value={stages} onChange={setStages} />}
      <p className="text-xs text-slate-400">Now: {describeIdle(r.idle.effective)}. Saving starts a fresh idle period for the router's lab.</p>
      {(dirty || (mode === 'custom' && r.idle.policy.mode !== 'custom')) && (
        <button className="btn-primary" onClick={() => void save()}>
          Save
        </button>
      )}
    </div>
  );
}
