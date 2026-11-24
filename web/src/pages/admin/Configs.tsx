import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ClipboardCheck, Link2, Plus, Server, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAction, useApp } from '../../lib/app-context';
import { useApi } from '../../lib/hooks';
import type { ConfigSetDef, DeployMode, Job, User } from '../../lib/types';
import { FieldForm, fieldDefaults } from '../../components/FieldForm';
import { JobConsole } from '../../components/JobConsole';
import { ConfirmDialog, EmptyState, Field, InfoNote, Modal, PageHeader, Spinner, Tabs, Toggle } from '../../components/ui';

interface HoloSummary {
  configId: string;
  site: 'a' | 'b';
  exists: boolean;
  instanceId: string | null;
  description: string | null;
  holorouterStatus: string | null;
  precheckCompleted: boolean;
  target: Record<string, string | null>;
  version: string | null;
  domain: string | null;
  vSANMode: string | null;
  flags: Record<string, unknown>;
}

interface ConfigDetailData {
  id: number;
  configId: string;
  name: string;
  description: string;
  enabled: boolean;
  entitleAll: boolean;
  userIds: number[];
  defaults: Record<string, unknown>;
  placement: { cluster?: string; datastore?: string; resourcePool?: string; portGroup?: string };
  depot: {
    buildToken: string;
    proxy: { enabled?: boolean; protocol?: string; ip?: string; port?: string; username?: string; password: string };
    offline: { ip?: string; port?: string; protocol?: string; username?: string; password: string };
  };
  holodeck: { a: HoloSummary; b: HoloSummary };
  /** Instances bound to this config on a router that aren't portal labs. */
  unmanaged?: { routerId: number; router: string; instanceId: string }[];
  targetType?: 'vcenter' | 'esxi' | null;
  activeLabs: number;
}

export function Configs() {
  const { data, reload } = useApi<{ configs: ConfigDetailData[]; unregistered: HoloSummary[] }>('/api/admin/configs');
  const [creating, setCreating] = useState(false);
  const [registering, setRegistering] = useState<HoloSummary | null>(null);
  return (
    <div>
      <PageHeader
        title="Configurations"
        subtitle="Holodeck configurations users can deploy from. Each wraps a Holodeck config (target vCenter/host, placement and depot)."
        actions={
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New configuration
          </button>
        }
      />
      {!data ? (
        <Spinner className="mx-auto size-6" />
      ) : (
        <div className="space-y-8">
          {data.configs.length === 0 ? (
            <EmptyState icon={<Server className="size-6" />} title="No configurations published">
              Register an existing Holodeck configuration below, or create a new one.
            </EmptyState>
          ) : (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {data.configs.map((c) => (
                <Link key={c.id} to={`/admin/configs/${c.id}`} className="panel block p-5 transition hover:border-ink-500">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-semibold text-white">{c.name}</div>
                      <div className="font-mono text-xs text-slate-500">{c.configId}</div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <TargetBadge type={c.targetType} />
                      <span className={`rounded-md px-2 py-0.5 text-xs ${c.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-ink-700 text-slate-400'}`}>
                        {c.enabled ? 'Published' : 'Disabled'}
                      </span>
                    </div>
                  </div>
                  {c.description && <p className="mt-2 text-sm text-slate-400">{c.description}</p>}
                  <div className="mt-4 space-y-1 font-mono text-xs text-slate-400">
                    <div>{c.holodeck.a.target.hostname}</div>
                    <div>
                      {c.holodeck.a.target.cluster} · {c.holodeck.a.target.datastore} · {c.holodeck.a.target.portGroup}
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2 text-xs">
                    <span className="rounded bg-ink-700 px-2 py-0.5 text-slate-300">{c.entitleAll ? 'All users' : `${c.userIds.length} users`}</span>
                    <span className="rounded bg-ink-700 px-2 py-0.5 text-slate-300">{c.activeLabs} labs</span>
                    {(c.unmanaged?.length ?? 0) > 0 && (
                      <span className="rounded bg-amber-500/15 px-2 py-0.5 text-amber-300">unmanaged instance on {c.unmanaged!.map((u) => u.router).join(', ')}</span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
          {data.unregistered.length > 0 && (
            <div>
              <h2 className="label-caps mb-3">Holodeck configurations not yet in the portal</h2>
              <div className="panel overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Config ID</th>
                      <th>Target</th>
                      <th>Version</th>
                      <th>Instance</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.unregistered.map((u) => (
                      <tr key={u.configId}>
                        <td className="font-mono">{u.configId}</td>
                        <td className="font-mono text-xs text-slate-300">
                          {u.target.hostname} / {u.target.cluster}
                        </td>
                        <td>{u.version}</td>
                        <td className="font-mono text-xs">{u.instanceId ?? '—'}</td>
                        <td className="text-right">
                          <button className="btn-secondary py-1" onClick={() => setRegistering(u)}>
                            <Link2 className="size-4" /> Register
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
      {creating && <NewConfigModal onClose={() => setCreating(false)} onDone={reload} />}
      {registering && <RegisterModal holo={registering} onClose={() => setRegistering(null)} onDone={reload} />}
    </div>
  );
}

function RegisterModal({ holo, onClose, onDone }: { holo: HoloSummary; onClose: () => void; onDone: () => void }) {
  const run = useAction();
  const navigate = useNavigate();
  const [name, setName] = useState(holo.target.cluster ? `${holo.target.cluster}` : holo.configId);
  const [description, setDescription] = useState(holo.description ?? '');
  return (
    <Modal
      open
      onClose={onClose}
      title={`Register ${holo.configId}`}
      footer={
        <button
          className="btn-primary"
          onClick={async () => {
            const r = await run(() => api.post<{ config: { id: number } }>('/api/admin/configs/register', { configId: holo.configId, name, description }), 'Configuration registered');
            if (r) {
              onDone();
              navigate(`/admin/configs/${r.config.id}`);
            }
          }}
        >
          Register
        </button>
      }
    >
      <div className="space-y-4">
        <Field label="Display name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function NewConfigModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const run = useAction();
  const [f, setF] = useState({ name: '', description: '', targetHost: '', username: 'administrator@vsphere.local', password: '' });
  const [job, setJob] = useState<string | null>(null);
  return (
    <Modal
      open
      wide={Boolean(job)}
      onClose={onClose}
      title="New Holodeck configuration"
      footer={
        !job && (
          <button
            className="btn-primary"
            disabled={!f.name || !f.targetHost || !f.username || !f.password}
            onClick={async () => {
              const r = await run(() => api.post<{ job: Job }>('/api/admin/configs/new', f));
              if (r) setJob(r.job.id);
            }}
          >
            Create
          </button>
        )
      }
    >
      {job ? (
        <JobConsole jobId={job} height="h-72" onFinished={(s) => s === 'succeeded' && onDone()} />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-400">Runs New-HoloDeckConfig and registers the result. Set placement and depot details afterwards.</p>
          <Field label="Display name *">
            <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Description">
            <input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          <Field label="Target host *" help="vCenter or ESX host FQDN/IP (-TargetHost)">
            <input className="input" value={f.targetHost} onChange={(e) => setF({ ...f, targetHost: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username *">
              <input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
            </Field>
            <Field label="Password *">
              <input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** vCenter or standalone ESXi host, from the configuration's target; "Target unknown" until it has been connected to. */
function TargetBadge({ type }: { type?: 'vcenter' | 'esxi' | null }) {
  if (type === 'vcenter') return <span className="rounded-md bg-sky-500/15 px-2 py-0.5 text-xs text-sky-300">vCenter</span>;
  if (type === 'esxi') return <span className="rounded-md bg-violet-500/15 px-2 py-0.5 text-xs text-violet-300">ESXi host</span>;
  return (
    <span className="rounded-md bg-ink-700 px-2 py-0.5 text-xs text-slate-400" title="Known once the portal has connected to the target (inventory or precheck).">
      Target unknown
    </span>
  );
}

// ---------------------------------------------------------------------------

type DetailTab = 'general' | 'access' | 'defaults' | 'depot' | 'holodeck' | 'maintenance';

export function ConfigDetail() {
  const { id } = useParams();
  const { data, reload } = useApi<{ config: ConfigDetailData }>(`/api/admin/configs/${id}`);
  const [tab, setTab] = useState<DetailTab>('general');
  const c = data?.config;
  if (!c) return <Spinner className="mx-auto size-6" />;
  return (
    <div>
      <PageHeader
        title={c.name}
        subtitle={
          <span className="flex items-center gap-2">
            <span className="font-mono">Holodeck config {c.configId}</span>
            <TargetBadge type={c.targetType} />
          </span>
        }
      />
      {(c.unmanaged?.length ?? 0) > 0 && (
        <div className="mb-6">
          <InfoNote tone="warn">
            <AlertTriangle className="mr-1 inline size-4" /> Holodeck has instance(s){' '}
            {c.unmanaged!.map((u) => `${u.instanceId} (on ${u.router})`).join(', ')} bound to this config that aren't portal labs, so those routers can't
            take new labs. Remove them under <strong>Maintenance</strong>.
          </InfoNote>
        </div>
      )}
      <Tabs<DetailTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'general', label: 'General' },
          { id: 'access', label: 'Entitlements' },
          { id: 'defaults', label: 'Deploy defaults' },
          { id: 'depot', label: 'Depot & placement' },
          { id: 'holodeck', label: 'Holodeck settings' },
          { id: 'maintenance', label: 'Maintenance' },
        ]}
      />
      <div className="mt-6">
        {tab === 'general' && <GeneralTab c={c} onSaved={reload} />}
        {tab === 'access' && <EntitlementsTab c={c} onSaved={reload} />}
        {tab === 'defaults' && <DefaultsTab c={c} onSaved={reload} />}
        {tab === 'depot' && <DepotTab c={c} onSaved={reload} />}
        {tab === 'holodeck' && <HoloDeckTab c={c} onDone={reload} />}
        {tab === 'maintenance' && <MaintenanceTab c={c} onDone={reload} />}
      </div>
    </div>
  );
}

function SummaryTable({ s }: { s: HoloSummary }) {
  const rows: [string, React.ReactNode][] = [
    ['Target host', s.target.hostname],
    ['Username', s.target.username],
    ['API type', s.target.apiType],
    ['Datacenter', s.target.datacenter],
    ['Cluster', s.target.cluster],
    ['Resource pool', s.target.resourcePool || '—'],
    ['Datastore', s.target.datastore],
    ['Trunk port group', s.target.portGroup],
    ['Version', s.version],
    ['vSAN mode', s.vSANMode],
    ['DNS domain', s.domain],
    ['Precheck completed', s.precheckCompleted ? 'yes' : 'no'],
    ['Holorouter', s.holorouterStatus],
    ['Bound instance', s.instanceId ?? '—'],
  ];
  return (
    <table className="table-base">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="w-48 text-slate-400">{k}</td>
            <td className="font-mono text-xs text-slate-100">{v ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GeneralTab({ c, onSaved }: { c: ConfigDetailData; onSaved: () => void }) {
  const run = useAction();
  const navigate = useNavigate();
  const [name, setName] = useState(c.name);
  const [description, setDescription] = useState(c.description);
  const [enabled, setEnabled] = useState(c.enabled);
  const [del, setDel] = useState(false);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="panel space-y-4 p-5">
        <Field label="Display name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea className="input min-h-20" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Toggle checked={enabled} onChange={setEnabled} label="Published" help="Disabled configurations are hidden from users." />
        <div className="flex gap-2">
          <button className="btn-primary" onClick={() => run(() => api.patch(`/api/admin/configs/${c.id}`, { name, description, enabled }), 'Saved').then(onSaved)}>
            Save
          </button>
          <button className="btn-danger ml-auto" onClick={() => setDel(true)}>
            <Trash2 className="size-4" /> Unregister
          </button>
        </div>
      </div>
      <div className="panel p-5">
        <h3 className="label-caps mb-2">Holodeck config (site A)</h3>
        <SummaryTable s={c.holodeck.a} />
      </div>
      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        danger
        title="Unregister configuration?"
        confirmLabel="Unregister"
        message="The Holodeck config files are left untouched. Configurations with lab history are disabled instead of deleted."
        onConfirm={() => run(() => api.del(`/api/admin/configs/${c.id}`), 'Done').then(() => navigate('/admin/configs'))}
      />
    </div>
  );
}

function EntitlementsTab({ c, onSaved }: { c: ConfigDetailData; onSaved: () => void }) {
  const run = useAction();
  const { data } = useApi<{ users: User[] }>('/api/admin/users');
  const [all, setAll] = useState(c.entitleAll);
  const [ids, setIds] = useState(new Set(c.userIds));
  return (
    <div className="panel max-w-2xl space-y-4 p-5">
      <Toggle checked={all} onChange={setAll} label="All users may deploy from this configuration" />
      {!all && (
        <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-ink-700 p-2">
          {data?.users
            .filter((u) => u.role !== 'admin')
            .map((u) => (
              <label key={u.id} className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-ink-800">
                <input
                  type="checkbox"
                  className="accent-blue-500"
                  checked={ids.has(u.id)}
                  onChange={(e) => {
                    const n = new Set(ids);
                    if (e.target.checked) n.add(u.id);
                    else n.delete(u.id);
                    setIds(n);
                  }}
                />
                <span className="text-sm text-slate-200">
                  {u.firstName} {u.lastName}
                </span>
                <span className="font-mono text-xs text-slate-500">{u.username}</span>
              </label>
            ))}
          <p className="px-2 pt-2 text-xs text-slate-500">Administrators can always deploy from every configuration.</p>
        </div>
      )}
      <button className="btn-primary" onClick={() => run(() => api.patch(`/api/admin/configs/${c.id}`, { entitleAll: all, userIds: [...ids] }), 'Entitlements saved').then(onSaved)}>
        Save
      </button>
    </div>
  );
}

function DefaultsTab({ c, onSaved }: { c: ConfigDetailData; onSaved: () => void }) {
  const { meta } = useApp();
  const run = useAction();
  const [mode, setMode] = useState<DeployMode>((c.defaults.mode as DeployMode) ?? 'VVF');
  const [version, setVersion] = useState((c.defaults.version as string) ?? c.holodeck.a.version ?? '9.1.0.0');
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...fieldDefaults(meta?.deployFields ?? []), ...c.defaults }));
  const fields = useMemo(
    () => (meta?.deployFields ?? []).filter((f) => (!f.modes || f.modes.includes(mode)) && (!f.v9Only || version.startsWith('9.'))),
    [meta, mode, version],
  );
  return (
    <div className="panel max-w-4xl space-y-5 p-5">
      <p className="text-sm text-slate-400">Pre-selected values on the deploy form for this configuration. Users can still change them.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Deployment type">
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as DeployMode)}>
            <option value="VVF">VVF</option>
            <option value="ManagementOnly">VCF management only</option>
            <option value="FullStack">VCF full stack</option>
          </select>
        </Field>
        <Field label="Version">
          <select className="input" value={version} onChange={(e) => setVersion(e.target.value)}>
            {meta?.versions.map((v) => <option key={v}>{v}</option>)}
          </select>
        </Field>
      </div>
      <FieldForm fields={fields} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} />
      <button
        className="btn-primary"
        onClick={() => {
          const defaults: Record<string, unknown> = { mode, version };
          for (const f of fields) if (values[f.name] !== undefined && values[f.name] !== '') defaults[f.name] = values[f.name];
          return run(() => api.patch(`/api/admin/configs/${c.id}`, { defaults }), 'Defaults saved').then(onSaved);
        }}
      >
        Save defaults
      </button>
    </div>
  );
}

function DepotTab({ c, onSaved }: { c: ConfigDetailData; onSaved: () => void }) {
  const run = useAction();
  const [placement, setPlacement] = useState(c.placement);
  const [token, setToken] = useState('');
  const [proxy, setProxy] = useState({ ...c.depot.proxy, password: '' });
  const [offline, setOffline] = useState({ ...c.depot.offline, password: '' });
  const t = c.holodeck.a.target;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="panel space-y-4 p-5">
        <h3 className="font-medium text-white">Placement for unattended prechecks</h3>
        <p className="text-sm text-slate-400">
          Holodeck asks for these during its first precheck. Blank fields use the values already in the Holodeck config.
        </p>
        {(
          [
            ['cluster', 'Cluster', t.cluster],
            ['datastore', 'Datastore', t.datastore],
            ['resourcePool', 'Resource pool', t.resourcePool],
            ['portGroup', 'Trunk port group', t.portGroup],
          ] as const
        ).map(([k, label, fallback]) => (
          <Field key={k} label={label}>
            <input className="input" placeholder={fallback ?? ''} value={placement[k] ?? ''} onChange={(e) => setPlacement({ ...placement, [k]: e.target.value })} />
          </Field>
        ))}
        <button className="btn-primary" onClick={() => run(() => api.patch(`/api/admin/configs/${c.id}`, { placement }), 'Placement saved').then(onSaved)}>
          Save placement
        </button>
      </div>

      <div className="panel space-y-4 p-5">
        <h3 className="font-medium text-white">Depot access</h3>
        <p className="text-sm text-slate-400">Stored encrypted and passed to Holodeck as environment variables. Leave secret fields blank to keep the saved value.</p>
        <Field label="Broadcom download token" help={c.depot.buildToken ? 'A token is saved.' : 'Used for VCF 9.0 and earlier. VCF 9.1 asks for an activation code during the deployment.'}>
          <input className="input" type="password" autoComplete="off" placeholder={c.depot.buildToken} value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <Toggle checked={Boolean(proxy.enabled)} onChange={(v) => setProxy({ ...proxy, enabled: v })} label="Use a proxy to reach the online depot" />
        {proxy.enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Protocol">
              <select className="input" value={proxy.protocol ?? 'HTTP'} onChange={(e) => setProxy({ ...proxy, protocol: e.target.value })}>
                <option>HTTP</option>
                <option>HTTPS</option>
              </select>
            </Field>
            <Field label="Proxy FQDN/IP">
              <input className="input" value={proxy.ip ?? ''} onChange={(e) => setProxy({ ...proxy, ip: e.target.value })} />
            </Field>
            <Field label="Port">
              <input className="input" value={proxy.port ?? ''} onChange={(e) => setProxy({ ...proxy, port: e.target.value })} />
            </Field>
            <Field label="Username">
              <input className="input" value={proxy.username ?? ''} onChange={(e) => setProxy({ ...proxy, username: e.target.value })} />
            </Field>
            <Field label="Password" className="sm:col-span-2">
              <input className="input" type="password" placeholder={c.depot.proxy.password} value={proxy.password} onChange={(e) => setProxy({ ...proxy, password: e.target.value })} />
            </Field>
          </div>
        )}
        <h4 className="label-caps pt-2">Offline depot</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Depot FQDN/IP">
            <input className="input" value={offline.ip ?? ''} onChange={(e) => setOffline({ ...offline, ip: e.target.value })} />
          </Field>
          <Field label="Port">
            <input className="input" value={offline.port ?? ''} onChange={(e) => setOffline({ ...offline, port: e.target.value })} />
          </Field>
          <Field label="Protocol">
            <select className="input" value={offline.protocol ?? 'https'} onChange={(e) => setOffline({ ...offline, protocol: e.target.value })}>
              <option>https</option>
              <option>http</option>
            </select>
          </Field>
          <Field label="Username">
            <input className="input" value={offline.username ?? ''} onChange={(e) => setOffline({ ...offline, username: e.target.value })} />
          </Field>
          <Field label="Password" className="sm:col-span-2">
            <input className="input" type="password" placeholder={c.depot.offline.password} value={offline.password} onChange={(e) => setOffline({ ...offline, password: e.target.value })} />
          </Field>
        </div>
        <button
          className="btn-primary"
          onClick={() =>
            run(() => api.put(`/api/admin/configs/${c.id}/depot`, { buildToken: token || undefined, proxy, offline }), 'Depot settings saved').then(() => {
              setToken('');
              onSaved();
            })
          }
        >
          Save depot settings
        </button>
      </div>
    </div>
  );
}

function HoloDeckTab({ c, onDone }: { c: ConfigDetailData; onDone: () => void }) {
  const { meta } = useApp();
  const [set, setSet] = useState<ConfigSetDef | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const groups = ['Target', 'Deployment', 'Depot', 'Advanced'] as const;
  return (
    <div className="space-y-6">
      <InfoNote>
        Each action runs <code>Set-HoloDeckConfig</code> with one of its parameter sets against this configuration. Changes apply to future deployments.
      </InfoNote>
      {job && <JobConsole jobId={job} height="h-64" onFinished={onDone} />}
      {groups.map((g) => (
        <div key={g}>
          <h3 className="label-caps mb-3">{g}</h3>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {meta?.configSets
              .filter((s) => s.group === g)
              .map((s) => (
                <button key={s.id} className="panel p-4 text-left transition hover:border-ink-500" onClick={() => setSet(s)}>
                  <div className="font-medium text-white">{s.label}</div>
                  <div className="mt-1 font-mono text-[11px] text-slate-500">{s.description}</div>
                </button>
              ))}
          </div>
        </div>
      ))}
      {set && <ConfigSetModal c={c} set={set} onClose={() => setSet(null)} onStarted={setJob} />}
    </div>
  );
}

function ConfigSetModal({ c, set, onClose, onStarted }: { c: ConfigDetailData; set: ConfigSetDef; onClose: () => void; onStarted: (job: string) => void }) {
  const run = useAction();
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of set.fields) if (f.type === 'select' && f.options?.length) v[f.name] = f.options[0];
    return v;
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={set.label}
      footer={
        <button
          className="btn-primary"
          onClick={async () => {
            const r = await run(() => api.post<{ job: Job }>(`/api/admin/configs/${c.id}/set`, { set: set.id, values }), 'Update started');
            if (r) {
              onStarted(r.job.id);
              onClose();
            }
          }}
        >
          Apply
        </button>
      }
    >
      <p className="mb-4 font-mono text-xs text-slate-400">Set-HoloDeckConfig {set.description}</p>
      <FieldForm fields={set.fields} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} columns={1} />
    </Modal>
  );
}

function MaintenanceTab({ c, onDone }: { c: ConfigDetailData; onDone: () => void }) {
  const { meta } = useApp();
  const run = useAction();
  const [job, setJob] = useState<string | null>(null);
  const [pre, setPre] = useState({ version: c.holodeck.a.version ?? '9.1.0.0', vvf: false, vSANMode: c.holodeck.a.vSANMode ?? 'OSA', deployVcfAutomation: false });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [target, setTarget] = useState<{ routerId: number; router: string; instanceId: string } | null>(null);
  const bound = target?.instanceId ?? null;
  return (
    <div className="space-y-6">
      {job && <JobConsole jobId={job} height="h-80" onFinished={onDone} />}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="panel space-y-4 p-5">
          <h3 className="flex items-center gap-2 font-medium text-white">
            <ClipboardCheck className="size-4" /> Run precheck
          </h3>
          <p className="text-sm text-slate-400">Start-HoloDeckPrecheck validates the target's CPU, memory, storage and networking.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Version">
              <select className="input" value={pre.version} onChange={(e) => setPre({ ...pre, version: e.target.value })}>
                {meta?.versions.map((v) => <option key={v}>{v}</option>)}
              </select>
            </Field>
            <Field label="vSAN mode">
              <select className="input" value={pre.vSANMode} onChange={(e) => setPre({ ...pre, vSANMode: e.target.value })}>
                <option>OSA</option>
                <option>ESA</option>
              </select>
            </Field>
          </div>
          <Toggle checked={pre.vvf} onChange={(v) => setPre({ ...pre, vvf: v })} label="VVF" />
          <Toggle checked={pre.deployVcfAutomation} onChange={(v) => setPre({ ...pre, deployVcfAutomation: v })} label="Include VCF Automation sizing" />
          <button
            className="btn-primary"
            onClick={async () => {
              const r = await run(() => api.post<{ job: Job }>(`/api/admin/configs/${c.id}/precheck`, pre), 'Precheck started');
              if (r) setJob(r.job.id);
            }}
          >
            Run precheck
          </button>
        </div>
        <div className="panel space-y-4 p-5">
          <h3 className="font-medium text-white">Unmanaged instance</h3>
          {c.unmanaged?.length ? (
            <>
              <p className="text-sm text-slate-400">
                Holodeck has instances bound to this configuration that aren't portal labs (e.g. manual tests). Remove them so new labs can deploy on
                those routers. This deletes the instance's VMs; the Holorouter keeps its services.
              </p>
              {c.unmanaged.map((u) => (
                <button key={`${u.routerId}-${u.instanceId}`} className="btn-danger" onClick={() => { setTarget(u); setConfirmRemove(true); }}>
                  <Trash2 className="size-4" /> Remove instance {u.instanceId} on {u.router}
                </button>
              ))}
            </>
          ) : (
            <p className="text-sm text-slate-400">No unmanaged instance is bound to this configuration on any Holorouter (as of their last checks).</p>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        danger
        title={`Remove instance ${bound}?`}
        confirmLabel="Remove"
        requireText={bound ?? ''}
        message="Runs Remove-HoloDeckInstance. All VMs of this instance are deleted; the Holorouter keeps its services and network configuration."
        onConfirm={async () => {
          const r = await run(() => api.post<{ job: Job }>(`/api/admin/configs/${c.id}/remove-instance`, { routerId: target!.routerId }), 'Removal started');
          if (r) setJob(r.job.id);
        }}
      />
    </div>
  );
}
