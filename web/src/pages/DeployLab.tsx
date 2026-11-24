import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, CheckCircle2, Layers, Rocket, Server, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useAction, useApp } from '../lib/app-context';
import { useApi } from '../lib/hooks';
import type { DeployConfig, DeployMode, FieldDef, Lab, SiteAllocation, User } from '../lib/types';
import { FieldForm, fieldDefaults } from '../components/FieldForm';
import { EmptyState, ErrorNote, Field, InfoNote, PageHeader, Spinner } from '../components/ui';

const modeCards: { id: DeployMode; title: string; text: string; icon: typeof Layers }[] = [
  { id: 'VVF', title: 'VVF', text: 'vSphere Foundation: vCenter, ESX and vSAN.', icon: Layers },
  { id: 'ManagementOnly', title: 'VCF management domain', text: 'VCF with the management domain only.', icon: Boxes },
  { id: 'FullStack', title: 'VCF full stack', text: 'Management plus a workload domain.', icon: Boxes },
];

function visibleFields(fields: FieldDef[], mode: DeployMode, version: string) {
  return fields.filter((f) => (!f.modes || f.modes.includes(mode)) && (!f.v9Only || version.startsWith('9.')));
}

/** Mirrors the server's buildNewInstanceParams so users see exactly what Holodeck will run. */
function commandPreview(mode: DeployMode, version: string, instanceId: string, site: SiteAllocation | undefined, opts: Record<string, unknown>, fields: FieldDef[]) {
  const parts = ['New-HoloDeckInstance', `-Version ${version}`, `-InstanceID ${instanceId || '<auto>'}`];
  if (site) parts.push(`-CIDR ${site.cidr}`, `-VLANRangeStart ${site.vlanStart}`);
  parts.push('-Site a');
  if (mode === 'VVF') parts.push('-VVF');
  if (mode === 'ManagementOnly') parts.push('-ManagementOnly');
  for (const f of fields) {
    const v = opts[f.name];
    if (v === undefined || v === '' || v === false) continue;
    parts.push(v === true ? `-${f.name}` : `-${f.name} ${v}`);
  }
  parts.push('-DeveloperMode');
  return parts.join(' ');
}

interface Preflight {
  ok: boolean;
  problems: string[];
  allocation: { slot: number; sites: SiteAllocation[] } | null;
  router: { id: number; name: string } | null;
  routers?: { id: number; name: string; slot: number }[];
  dnsDomainTemplate: string;
  /** What a blank instance ID becomes on the chosen router's slot. */
  suggestedInstanceId?: string | null;
  /** Whether some free router (the pinned one, if any) has each version's installation files. */
  versionAvailability?: Record<string, boolean>;
}

export function DeployLab() {
  const { meta, user } = useApp();
  const navigate = useNavigate();
  const run = useAction();
  const configs = useApi<{ configs: DeployConfig[] }>('/api/configs');
  const users = useApi<{ users: User[] }>(user?.role === 'admin' ? '/api/admin/users' : null);
  const [configId, setConfigId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [leaseDays, setLeaseDays] = useState<number>(meta?.lease.defaultDays ?? 14);
  const [ownerId, setOwnerId] = useState<number | ''>('');
  const [routerId, setRouterId] = useState<number | ''>('');
  const [mode, setMode] = useState<DeployMode>('VVF');
  const [version, setVersion] = useState('9.1.0.0');
  const [opts, setOpts] = useState<Record<string, unknown>>({});
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);

  const allFields = meta?.deployFields ?? [];
  const isAdmin = user?.role === 'admin';
  // The DNS domain is per lab and set by the portal; only administrators may override it.
  const fields = useMemo(() => visibleFields(allFields, mode, version).filter((f) => isAdmin || !f.adminOnly), [allFields, mode, version, isAdmin]);
  const cfg = configs.data?.configs.find((c) => c.id === configId);

  // Pick the first configuration and apply its defaults.
  useEffect(() => {
    const list = configs.data?.configs;
    if (list?.length && configId === null) setConfigId((list.find((c) => c.availability === 'available') ?? list[0]).id);
  }, [configs.data, configId]);
  useEffect(() => {
    if (!cfg) return;
    const d = cfg.defaults as Record<string, unknown>;
    setOpts({ ...fieldDefaults(allFields), ...d });
    if (typeof d.mode === 'string') setMode(d.mode as DeployMode);
    if (typeof d.version === 'string') setVersion(d.version);
    else if (cfg.version) setVersion(cfg.version);
  }, [cfg, allFields]);
  useEffect(() => {
    if (meta) setLeaseDays(meta.lease.defaultDays);
  }, [meta]);

  // Preflight: quota, capacity, entitlement and the address that will be assigned.
  useEffect(() => {
    if (!configId) return;
    const t = setTimeout(() => {
      api
        .post<Preflight>('/api/labs/preflight', { configId, options: { ...opts, mode, version }, ownerId: ownerId || undefined, routerId: routerId || undefined })
        .then(setPreflight)
        .catch(() => setPreflight(null));
    }, 300);
    return () => clearTimeout(t);
  }, [configId, mode, version, opts, ownerId, routerId]);

  if (configs.loading || !meta) return <Spinner className="mx-auto size-6" />;
  if (!configs.data?.configs.length) {
    return (
      <EmptyState icon={<Server className="size-6" />} title="No configurations available">
        An administrator needs to publish a Holodeck configuration to you, with a Holorouter to run it, before you can deploy a lab.
      </EmptyState>
    );
  }

  const siteA = preflight?.allocation?.sites.find((s) => s.site === 'a');
  const instanceValid = !instanceId || /^[a-zA-Z0-9]{1,8}$/.test(instanceId);
  const canSubmit = Boolean(preflight?.ok && name.trim() && instanceValid && !busy);
  const optionValues = Object.fromEntries(fields.map((f) => [f.name, opts[f.name]]));

  return (
    <div>
      <PageHeader title="Deploy a lab" subtitle="Choose a configuration and Holodeck options. Networking is assigned automatically." />
      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <div className="space-y-6">
          <section className="panel p-5">
            <h2 className="label-caps mb-4">1 · Configuration</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {configs.data.configs.map((c) => (
                <button
                  key={c.id}
                  disabled={c.availability !== 'available'}
                  onClick={() => setConfigId(c.id)}
                  title={c.availability === 'busy' ? 'Every Holorouter for this configuration is in use.' : c.availability === 'unmapped' ? 'No Holorouter serves this configuration.' : undefined}
                  className={`rounded-xl border p-4 text-left transition ${
                    c.availability !== 'available'
                      ? 'cursor-not-allowed border-ink-800 bg-ink-900/50 opacity-50'
                      : configId === c.id
                        ? 'border-accent bg-accent-soft/30'
                        : 'border-ink-700 bg-ink-900 hover:border-ink-500'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-white">{c.name}</span>
                    {c.availability === 'busy' && <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[11px] text-slate-300">all Holorouters in use</span>}
                    {c.availability === 'unmapped' && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300">no Holorouter (admins only see this)</span>}
                  </div>
                  {c.description && <div className="mt-0.5 text-xs text-slate-400">{c.description}</div>}
                  <div className="mt-2 font-mono text-[11px] text-slate-500">
                    {c.target.hostname} · {c.target.cluster} · {c.target.datastore}
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="label-caps mb-4">2 · Lab details</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name *">
                <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. NSX troubleshooting" />
              </Field>
              <Field label="Instance ID" help="-InstanceID · 1–8 letters/digits, prefixes every VM name. Blank = s + the lab's slot.">
                <input
                  className={`input font-mono ${instanceValid ? '' : 'border-red-500'}`}
                  value={instanceId}
                  maxLength={8}
                  onChange={(e) => setInstanceId(e.target.value)}
                  placeholder={preflight?.suggestedInstanceId ?? 'auto'}
                />
              </Field>
              <Field label="Description" className="sm:col-span-2">
                <input className="input" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <Field label="Lease (days)" help={`Default ${meta.lease.defaultDays} days, maximum ${meta.lease.maxDays}. The lab is powered off when the lease ends.`}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={user?.role === 'admin' ? undefined : meta.lease.maxDays}
                  step={1}
                  value={leaseDays}
                  onChange={(e) => setLeaseDays(Math.floor(Number(e.target.value)))}
                />
              </Field>
              {user?.role === 'admin' && (
                <Field label="Owner" help="Deploy on behalf of another user.">
                  <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">Me</option>
                    {users.data?.users
                      .filter((u) => u.id !== user.id && u.enabled)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.firstName} {u.lastName} ({u.username})
                        </option>
                      ))}
                  </select>
                </Field>
              )}
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="label-caps mb-4">3 · Deployment type</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {modeCards.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={`rounded-xl border p-4 text-left transition ${mode === m.id ? 'border-accent bg-accent-soft/30' : 'border-ink-700 bg-ink-900 hover:border-ink-500'}`}
                >
                  <m.icon className="mb-2 size-5 text-blue-300" />
                  <div className="font-medium text-white">{m.title}</div>
                  <div className="mt-0.5 text-xs text-slate-400">{m.text}</div>
                  <div className="mt-2 font-mono text-[11px] text-slate-500">{m.id === 'VVF' ? '-VVF' : m.id === 'ManagementOnly' ? '-ManagementOnly' : '(full stack)'}</div>
                </button>
              ))}
            </div>
            <div className="mt-4 max-w-xs">
              <Field label="Version" help="-Version">
                <select className="input" value={version} onChange={(e) => setVersion(e.target.value)}>
                  {meta.versions.map((v) => {
                    const unavailable = preflight?.versionAvailability && !preflight.versionAvailability[v];
                    return (
                      <option key={v} value={v} disabled={unavailable && v !== version}>
                        {v}
                        {unavailable ? ' — not staged on a free Holorouter' : ''}
                      </option>
                    );
                  })}
                </select>
              </Field>
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="label-caps mb-4">4 · Holodeck options</h2>
            <FieldForm fields={fields} values={optionValues} onChange={(n, v) => setOpts((o) => ({ ...o, [n]: v }))} />
          </section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <div className="panel p-5">
            <h2 className="label-caps mb-3">Holorouter &amp; network</h2>
            {isAdmin && preflight?.routers && (
              <Field label="Holorouter" help="Pin the lab to a free router, or let the portal pick the lowest free slot." className="mb-3">
                <select className="input" value={routerId} onChange={(e) => setRouterId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Automatic</option>
                  {preflight.routers.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} (slot {r.slot})
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {preflight?.allocation ? (
              <div className="space-y-2">
                <div className="text-sm text-slate-300">
                  {preflight.router ? `${preflight.router.name} · ` : ''}slot {preflight.allocation.slot}
                </div>
                {preflight.allocation.sites.map((s) => (
                  <div key={s.site} className="flex items-center justify-between rounded-lg bg-ink-900 px-3 py-2 font-mono text-xs">
                    <span className="text-slate-400">site {s.site}</span>
                    <span className={s.reserved ? 'text-slate-500' : 'text-white'}>{s.cidr}</span>
                    <span className="text-slate-400">VLAN {s.vlanStart}+</span>
                  </div>
                ))}
                <p className="text-xs text-slate-500">Site B is reserved for future dual-site support.</p>
                {!opts.DNSDomain && name && (
                  <p className="text-xs text-slate-500">
                    DNS domain: <span className="font-mono text-slate-300">{preflight.dnsDomainTemplate
                        .replaceAll('{slot}', String(preflight.allocation.slot).padStart(2, '0'))
                        .replaceAll('{instance}', (instanceId || preflight.suggestedInstanceId || '<instance>').toLowerCase())}</span>
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-400">No Holorouter is free.</p>
            )}
          </div>

          <div className="panel p-5">
            <h2 className="label-caps mb-3">Checks</h2>
            {!preflight ? (
              <Spinner />
            ) : preflight.ok ? (
              <div className="flex items-center gap-2 text-sm text-emerald-300">
                <CheckCircle2 className="size-4" /> Ready to deploy
              </div>
            ) : (
              <ul className="space-y-2">
                {preflight.problems.map((p) => (
                  <li key={p} className="flex gap-2 text-sm text-red-300">
                    <XCircle className="mt-0.5 size-4 shrink-0" /> {p}
                  </li>
                ))}
              </ul>
            )}
            {!instanceValid && <ErrorNote>Instance ID must be 1–8 letters or digits.</ErrorNote>}
          </div>

          <div className="panel p-5">
            <h2 className="label-caps mb-3">Command</h2>
            <pre className="font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-slate-300">
              {commandPreview(mode, version, instanceId || preflight?.suggestedInstanceId || '', siteA, opts, fields)}
            </pre>
          </div>

          {opts.DepotType === 'Online' && version.startsWith('9.1') && (
            <InfoNote>
              VCF 9.1 online depots need an activation code generated for the VCF Installer's Download Service ID. When the deployment reaches that point,
              the job will ask you for it here in the portal.
            </InfoNote>
          )}

          <button
            className="btn-primary w-full py-2.5"
            disabled={!canSubmit}
            onClick={async () => {
              setBusy(true);
              const values = Object.fromEntries(fields.map((f) => [f.name, opts[f.name]]).filter(([, v]) => v !== undefined && v !== ''));
              const r = await run(
                () =>
                  api.post<{ lab: Lab }>('/api/labs', {
                    configId,
                    name: name.trim(),
                    description: description.trim() || undefined,
                    instanceId: instanceId || undefined,
                    leaseDays,
                    ownerId: ownerId || undefined,
                    routerId: routerId || undefined,
                    options: { mode, version, ...values },
                  }),
                'Deployment queued',
              );
              setBusy(false);
              if (r) navigate(`/labs/${r.lab.id}?tab=activity`);
            }}
          >
            {busy ? <Spinner /> : <Rocket className="size-4" />} Deploy lab
          </button>
        </aside>
      </div>
    </div>
  );
}
