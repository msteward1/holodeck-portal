import { CertificateSettings } from './CertificateSettings';
import { IdleStagesEditor, type IdleStages } from '../../components/IdleStages';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { useAction, useApp } from '../../lib/app-context';
import { useApi } from '../../lib/hooks';
import type { PoolSlot } from '../../lib/types';
import { CopyButton, ErrorNote, Field, InfoNote, PageHeader, Spinner, Toggle } from '../../components/ui';

type Duration = { value: number; unit: 'hours' | 'days' };
type HostRange = { min: number; max: number; default: number };

/** Minimum / default / maximum for one host setting, inside its hard limits. */
function RangeInput({ label, unit, lo, hi, value, onChange }: { label: string; unit?: string; lo: number; hi: number; value: HostRange; onChange: (r: HostRange) => void }) {
  return (
    <Field label={label} help={`Allowed ${lo}–${hi}${unit ? ` ${unit}` : ''}.`}>
      <div className="grid grid-cols-3 gap-2">
        {(['min', 'default', 'max'] as const).map((k) => (
          <label key={k} className="text-xs text-slate-400">
            {k === 'min' ? 'Minimum' : k === 'max' ? 'Maximum' : 'Default'}
            <input className="input mt-1" type="number" min={lo} max={hi} value={value[k]} onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
    </Field>
  );
}

interface SettingsData {
  general: { portalName: string; auditRetentionDays: number };
  jobs: { promptTimeoutHours: number; promptReminderHours: number };
  capacity: { maxActiveLabs: number; defaultUserQuota: number };
  hosts: { cpu: HostRange; memoryGb: HostRange; disks: HostRange; diskSizeGb: HostRange; maxHostsPerSite: number };
  lease: { defaultDays: number; maxDays: number; usersCanExtend: boolean; firstWarning: Duration; secondWarning: Duration };
  idle: IdleStages;
  updates: { autoCheck: boolean; allowInsecureHttp: boolean; source: { type: 'github'; repo: string } | { type: 'gitlab'; url: string; project: string } };
  network: {
    firstOctet: number;
    secondOctetStart: number;
    secondOctetEnd: number;
    sitesPerLab: 2;
    vlanMultiplier: number;
    blockedVlans: string;
    blockedNetworks: string;
    dnsDomainTemplate: string;
  };
  holorouters: { ovaUrl: string; ovaSha256: string; requireOvaDigest: boolean; strictVcenterTrust: boolean; webtopGateway: { enabled: boolean; defaultMode: 'direct' | 'portal' | 'portal-only' }; depotCaPem: string; webtopUsername: string; webtopPort: number; healthCheckMinutes: number };
  auth: {
    localEnabled: boolean;
    oidc: {
      enabled: boolean;
      displayName: string;
      issuer: string;
      clientId: string;
      scopes: string;
      usernameClaim: string;
      groupsClaim: string;
      adminGroups: string[];
      userGroups: string[];
      autoProvision: boolean;
    };
    saml: {
      enabled: boolean;
      displayName: string;
      entryPoint: string;
      idpIssuer: string;
      idpCert: string;
      spEntityId: string;
      usernameAttribute: string;
      emailAttribute: string;
      firstNameAttribute: string;
      lastNameAttribute: string;
      groupsAttribute: string;
      adminGroups: string[];
      userGroups: string[];
      autoProvision: boolean;
    };
  };
}

interface SettingsResponse {
  settings: SettingsData;
  oidcSecretSet: boolean;
  webtopPasswordSet: boolean;
  updatesTokenSet: boolean;
  sso: { oidcRedirectUri: string; samlAcsUrl: string; samlEntityId: string; samlMetadataUrl: string };
  pool: {
    slots: PoolSlot[];
    skipped: { cidrs: string[]; reasons: string[] }[];
    problems: string[];
    managementNetworks: { cidr: string; label: string }[];
  };
  activeLabs: number;
}

function Section({ title, description, children, onSave }: { title: string; description?: ReactNode; children: ReactNode; onSave: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="panel p-6">
      <h2 className="text-base font-semibold text-white">{title}</h2>
      {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
      <div className="mt-5 space-y-4">{children}</div>
      <button
        className="btn-primary mt-5"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onSave();
          setBusy(false);
        }}
      >
        {busy && <Spinner />} Save
      </button>
    </section>
  );
}

function NumberInput({ value, onChange, min, max }: { value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  return <input className="input" type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />;
}

function DurationInput({ value, onChange }: { value: Duration; onChange: (d: Duration) => void }) {
  return (
    <div className="flex gap-2">
      <input className="input w-24" type="number" min={1} value={value.value} onChange={(e) => onChange({ ...value, value: Number(e.target.value) })} />
      <select className="input w-32" value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as Duration['unit'] })}>
        <option value="hours">hours</option>
        <option value="days">days</option>
      </select>
      <span className="self-center text-sm text-slate-400">before expiry</span>
    </div>
  );
}

const listToText = (l: string[]) => l.join(', ');
const textToList = (t: string) =>
  t
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function Settings() {
  const { data, reload } = useApi<SettingsResponse>('/api/admin/settings');
  const [s, setS] = useState<SettingsData | null>(null);
  const [oidcSecret, setOidcSecret] = useState('');
  const [webtopPassword, setWebtopPassword] = useState('');
  const [updatesToken, setUpdatesToken] = useState('');
  const run = useAction();
  const { refreshUser } = useApp();
  useEffect(() => {
    if (data) setS(structuredClone(data.settings));
  }, [data]);
  if (!data || !s) return <Spinner className="mx-auto size-6" />;

  const save = <K extends keyof SettingsData>(section: K) =>
    run(() => api.put(`/api/admin/settings/${section}`, s[section]), 'Settings saved').then(() => {
      void reload();
      if (section === 'general') void refreshUser();
    });
  const upd = <K extends keyof SettingsData>(section: K, patch: Partial<SettingsData[K]>) => setS({ ...s, [section]: { ...s[section], ...patch } });
  const updAuth = <K extends 'oidc' | 'saml'>(k: K, patch: Partial<SettingsData['auth'][K]>) =>
    setS({ ...s, auth: { ...s.auth, [k]: { ...s.auth[k], ...patch } } });

  const slotCount = data.pool.slots.length;

  return (
    <div>
      <PageHeader title="Settings" subtitle="Portal-wide limits, leases, networking and sign-in." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="General" onSave={() => save('general')}>
          <Field label="Portal name">
            <input className="input" value={s.general.portalName} onChange={(e) => upd('general', { portalName: e.target.value })} />
          </Field>
          <Field label="Keep the audit log for (days)" help="30–3650. Older entries are deleted by the hourly clean-up.">
            <NumberInput min={30} max={3650} value={s.general.auditRetentionDays} onChange={(n) => upd('general', { auditRetentionDays: n })} />
          </Field>
        </Section>

        <CertificateSettings />

        <Section
          title="Updates"
          description="Where the portal looks for new releases (About shows them, with Update on the appliance). Every release is signed; the portal and the appliance's updater refuse anything that isn't."
          onSave={() => save('updates')}
        >
          <Toggle checked={s.updates.autoCheck} onChange={(v) => upd('updates', { autoCheck: v })} label="Check for updates every day (administrators are notified)" />
          <Field label="Release source">
            <select
              className="input"
              value={s.updates.source.type}
              onChange={(e) =>
                upd('updates', {
                  source: e.target.value === 'gitlab' ? { type: 'gitlab', url: '', project: '' } : { type: 'github', repo: '' },
                })
              }
            >
              <option value="github">GitHub (public releases)</option>
              <option value="gitlab">GitLab (self-hosted)</option>
            </select>
          </Field>
          {s.updates.source.type === 'github' ? (
            <Field label="Repository" help="owner/name">
              <input
                className="input font-mono"
                value={s.updates.source.repo}
                onChange={(e) => upd('updates', { source: { type: 'github', repo: e.target.value.trim() } })}
              />
            </Field>
          ) : (
            <>
              <Field label="GitLab URL" help="e.g. https://gitlab.example.com">
                <input
                  className="input font-mono"
                  value={s.updates.source.url}
                  onChange={(e) => upd('updates', { source: { ...(s.updates.source as { type: 'gitlab'; url: string; project: string }), url: e.target.value.trim() } })}
                />
              </Field>
              <Field label="Project" help="group/project">
                <input
                  className="input font-mono"
                  value={s.updates.source.project}
                  onChange={(e) => upd('updates', { source: { ...(s.updates.source as { type: 'gitlab'; url: string; project: string }), project: e.target.value.trim() } })}
                />
              </Field>
              {s.updates.source.url.startsWith('http://') && (
                <InfoNote tone="warn">
                  This GitLab uses plain HTTP. Checks are refused unless you allow it below; the token then travels unencrypted.
                </InfoNote>
              )}
              <Toggle
                checked={s.updates.allowInsecureHttp}
                onChange={(v) => upd('updates', { allowInsecureHttp: v })}
                label="Allow plain HTTP (the token is sent unencrypted)"
              />
              <Field label="Access token" help={`${data.updatesTokenSet ? 'Set. ' : ''}A read-only token (read_api) if the project isn't public; stored encrypted and only sent to this GitLab server, never through a redirect to another one.`}>
                <div className="flex gap-2">
                  <input className="input" type="password" autoComplete="off" value={updatesToken} placeholder={data.updatesTokenSet ? '••••••••' : ''} onChange={(e) => setUpdatesToken(e.target.value)} />
                  <button
                    className="btn-secondary"
                    onClick={async () => {
                      const ok = await run(() => api.put('/api/admin/settings/updates-token', { token: updatesToken }), updatesToken ? 'Token saved' : 'Token removed');
                      if (ok) {
                        setUpdatesToken('');
                        void reload();
                      }
                    }}
                  >
                    {updatesToken ? 'Save token' : 'Remove token'}
                  </button>
                </div>
              </Field>
            </>
          )}
        </Section>

        <Section
          title="Jobs waiting for an answer"
          description="Some Holodeck steps ask a question in the job console. A job left waiting holds its lab (and its Holorouter) until it is answered."
          onSave={() => save('jobs')}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Remind the owner after (hours)" help="0 = no reminder.">
              <NumberInput min={0} max={720} value={s.jobs.promptReminderHours} onChange={(n) => upd('jobs', { promptReminderHours: n })} />
            </Field>
            <Field label="Cancel the job after (hours)" help="0 = wait forever. A cancelled deployment can be retried.">
              <NumberInput min={0} max={720} value={s.jobs.promptTimeoutHours} onChange={(n) => upd('jobs', { promptTimeoutHours: n })} />
            </Field>
          </div>
        </Section>

        <Section
          title="Capacity & quotas"
          description="Labs counted toward limits include those deploying, failed or powered off; only removal frees capacity."
          onSave={() => save('capacity')}
        >
          <Field
            label="Maximum labs across the portal"
            help={`Each Holorouter runs one lab, so the effective limit is the lower of this and the number of healthy Holorouters (at most ${slotCount}, one per network slot).`}
          >
            <NumberInput min={1} max={10} value={s.capacity.maxActiveLabs} onChange={(n) => upd('capacity', { maxActiveLabs: n })} />
          </Field>
          <Field label="Default labs per user" help="Overridable per user.">
            <NumberInput min={0} max={10} value={s.capacity.defaultUserQuota} onChange={(n) => upd('capacity', { defaultUserQuota: n })} />
          </Field>
          
        </Section>

        <Section
          title="Day-2 host limits"
          description="What users may request with Add ESX hosts, and how many nested hosts a lab may have per site. Holodeck deploys a lab with 4 hosts (12 vCPU, 32 GB, 2 × 450 GB) and every added cluster has 3; neither can be changed. Administrators aren't held to the per-site total."
          onSave={() => save('hosts')}
        >
          <RangeInput label="vCPUs per host" lo={2} hi={64} value={s.hosts.cpu} onChange={(r) => upd('hosts', { cpu: r })} />
          <RangeInput label="Memory per host" unit="GB" lo={8} hi={1024} value={s.hosts.memoryGb} onChange={(r) => upd('hosts', { memoryGb: r })} />
          <RangeInput label="Disks per host" lo={1} hi={3} value={s.hosts.disks} onChange={(r) => upd('hosts', { disks: r })} />
          <RangeInput label="Disk size" unit="GB" lo={1} hi={16384} value={s.hosts.diskSizeGb} onChange={(r) => upd('hosts', { diskSizeGb: r })} />
          <Field label="Hosts per lab site" help="4–64. Counts the lab's 4 hosts, 3 per added cluster, and added hosts. At 8, a user can add one cluster and one host; at 4, nothing.">
            <NumberInput min={4} max={64} value={s.hosts.maxHostsPerSite} onChange={(n) => upd('hosts', { maxHostsPerSite: n })} />
          </Field>
        </Section>

        <Section
          title="Leases & warnings"
          description="When a lease ends the lab is powered off (not deleted). Administrators can renew or remove expired labs."
          onSave={() => save('lease')}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default lease (days)">
              <NumberInput min={1} max={365} value={s.lease.defaultDays} onChange={(n) => upd('lease', { defaultDays: n })} />
            </Field>
            <Field label="Maximum lease (days)" help="Up to 365. Also caps how far users can extend.">
              <NumberInput min={1} max={365} value={s.lease.maxDays} onChange={(n) => upd('lease', { maxDays: n })} />
            </Field>
          </div>
          <Toggle checked={s.lease.usersCanExtend} onChange={(v) => upd('lease', { usersCanExtend: v })} label="Users can extend their own leases" />
          <Field label="First warning">
            <DurationInput value={s.lease.firstWarning} onChange={(d) => upd('lease', { firstWarning: d })} />
          </Field>
          <Field label="Second warning">
            <DurationInput value={s.lease.secondWarning} onChange={(d) => upd('lease', { secondWarning: d })} />
          </Field>
        </Section>

        <Section
          title="Idle labs"
          description={
            <>
              The default for every Holorouter; each router can follow it, set its own stages or opt out, and administrators can exempt single labs.
              Use means: the owner opening the lab in the portal, viewing credentials, running lab actions or extending the lease, and webtop sessions
              with recent traffic. The owner is warned a day before each stage and can choose <em>Keep running</em>. A suspended lab is resumed before
              it is shut down (Holodeck signs in to the nested hosts to shut them down).
            </>
          }
          onSave={() => save('idle')}
        >
          <IdleStagesEditor value={s.idle} onChange={(v) => setS({ ...s, idle: v })} />
        </Section>

        <Section
          title="Network pool"
          description="Each lab gets two consecutive /20s (site A deployed, site B reserved). VLAN range start = second octet × multiplier."
          onSave={() => save('network')}
        >
          {data.activeLabs > 0 && <InfoNote tone="warn">Labs are deployed: only the pool end and DNS domain template can change until they're removed.</InfoNote>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First octet">
              <NumberInput min={1} max={223} value={s.network.firstOctet} onChange={(n) => upd('network', { firstOctet: n })} />
            </Field>
            <Field label="VLAN multiplier">
              <NumberInput min={1} max={1000} value={s.network.vlanMultiplier} onChange={(n) => upd('network', { vlanMultiplier: n })} />
            </Field>
            <Field label="Second octet — start">
              <NumberInput min={0} max={255} value={s.network.secondOctetStart} onChange={(n) => upd('network', { secondOctetStart: n })} />
            </Field>
            <Field label="Second octet — end">
              <NumberInput min={0} max={255} value={s.network.secondOctetEnd} onChange={(n) => upd('network', { secondOctetEnd: n })} />
            </Field>
            <Field
              label="Blocked VLANs"
              help="VLANs used elsewhere on your network, e.g. 1210-1218. A pool range whose VLANs touch one is skipped; the pool continues with the next range."
            >
              <input className="input font-mono" value={s.network.blockedVlans} placeholder="1210-1218, 1500" onChange={(e) => upd('network', { blockedVlans: e.target.value })} />
            </Field>
            <Field
              label="Blocked networks"
              help="Networks used elsewhere, e.g. 192.0.2.0/24. A pool range that overlaps one is skipped."
            >
              <input className="input font-mono" value={s.network.blockedNetworks} placeholder="192.0.2.0/24, 198.51.100.0/24" onChange={(e) => upd('network', { blockedNetworks: e.target.value })} />
            </Field>
            <Field
              label="Per-lab DNS domain"
              help={`Passed as -DNSDomain. {slot} becomes the lab's network slot (two digits) and {instance} its instance ID; slot 6 gives ${s.network.dnsDomainTemplate.replaceAll('{slot}', '06').replaceAll('{instance}', 's06')}. A slot runs one lab at a time, so {slot} names never clash. Applies to new labs. Users can't change it; administrators can override it per lab.`}
              className="sm:col-span-2"
            >
              <input className="input font-mono" value={s.network.dnsDomainTemplate} placeholder="lab{slot}.vcf.lab" onChange={(e) => upd('network', { dnsDomainTemplate: e.target.value })} />
            </Field>
          </div>
          <p className="text-sm text-slate-400">
            {slotCount} usable slot(s) (saved settings):{' '}
            {data.pool.slots.map((sl) => `${sl.slot}: ${sl.sites[0]?.cidr} (VLAN ${sl.sites[0]?.vlanStart})`).join(' · ')}
          </p>
          {data.pool.skipped.length > 0 && (
            <InfoNote>
              Skipped:{' '}
              {data.pool.skipped.map((g) => `${g.cidrs.join(' + ')} (${g.reasons.join('; ')})`).join(' · ')}
            </InfoNote>
          )}
          {data.pool.managementNetworks.length > 0 && (
            <p className="text-xs text-slate-500">
              Management networks the portal sees, which no slot may overlap: {data.pool.managementNetworks.map((m) => `${m.cidr} (${m.label})`).join(', ')}.
            </p>
          )}
          {data.pool.problems.map((p) => (
            <ErrorNote key={p}>{p}</ErrorNote>
          ))}
        </Section>

        <Section
          title="Holorouters"
          description="Deploying new Holorouters, the webtop login shown to lab owners, and how often secondary routers are checked."
          onSave={() => save('holorouters')}
        >
          <Field label="Holorouter OVA URL" help="Downloaded to the portal (and kept for later deployments), checked, then deployed with PowerCLI.">
            <input
              className="input font-mono"
              value={s.holorouters.ovaUrl}
              placeholder="https://depot.example.com/holorouter/holorouter-9.1.0.ova"
              onChange={(e) => upd('holorouters', { ovaUrl: e.target.value })}
            />
          </Field>
          <Field
            label="OVA SHA-256"
            help="The digest of the OVA you trust (e.g. from the download page or computed with sha256sum). An OVA that doesn't match is never deployed. Required for an http:// URL; optional for https://, where the depot's certificate is verified instead."
          >
            <input
              className="input font-mono"
              value={s.holorouters.ovaSha256}
              placeholder="64 hexadecimal characters"
              onChange={(e) => upd('holorouters', { ovaSha256: e.target.value.trim() })}
            />
          </Field>
          <Toggle
            checked={s.holorouters.strictVcenterTrust}
            onChange={(v) => upd('holorouters', { strictVcenterTrust: v })}
            label="Verify the vCenter sign-in strictly during router deployments (vCenter targets)"
          />
          <Toggle
            checked={s.holorouters.requireOvaDigest}
            onChange={(v) => upd('holorouters', { requireOvaDigest: v })}
            label="Require the SHA-256 for https:// URLs too"
          />
          {s.holorouters.ovaUrl && !s.holorouters.ovaSha256 && (s.holorouters.ovaUrl.startsWith('http://') || s.holorouters.requireOvaDigest) && (
            <InfoNote tone="warn">
              New Holorouters can't be deployed until the OVA's SHA-256 is set
              {s.holorouters.ovaUrl.startsWith('http://') ? ': the URL is plain HTTP, so the digest is the only way to authenticate the OVA' : ''}. Existing routers
              and labs are not affected.
            </InfoNote>
          )}
          <Field label="Depot CA certificate" help="Optional PEM, for an https:// depot whose certificate isn't publicly trusted. Not needed when a SHA-256 is set.">
            <textarea
              className="input h-20 font-mono text-xs"
              value={s.holorouters.depotCaPem}
              placeholder="-----BEGIN CERTIFICATE-----"
              onChange={(e) => upd('holorouters', { depotCaPem: e.target.value })}
            />
          </Field>
          <div className="space-y-3 rounded-lg border border-ink-700 p-4">
            <Toggle
              checked={s.holorouters.webtopGateway.enabled}
              onChange={(v) => upd('holorouters', { webtopGateway: { ...s.holorouters.webtopGateway, enabled: v } })}
              label="Webtop gateway: let routers open their webtop through the portal"
            />
            <p className="text-xs text-slate-400">
              Optional. Through the portal, a webtop opens over HTTPS on its own portal port (8440 + the router's slot), only for the
              owner of the router's lab and administrators, and the portal signs in for them, so nobody sees the webtop password. Each
              router chooses its mode on its own page; routers left on <em>Direct</em> work exactly as before.
            </p>
            {s.holorouters.webtopGateway.enabled && (
              <Field label="Mode for routers without their own choice">
                <select
                  className="input"
                  value={s.holorouters.webtopGateway.defaultMode}
                  onChange={(e) => upd('holorouters', { webtopGateway: { ...s.holorouters.webtopGateway, defaultMode: e.target.value as 'direct' } })}
                >
                  <option value="direct">Direct (link to the router, password shown)</option>
                  <option value="portal">Through the portal</option>
                  <option value="portal-only">Through the portal only (router's own webtop closed)</option>
                </select>
              </Field>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Webtop username">
              <input className="input" value={s.holorouters.webtopUsername} onChange={(e) => upd('holorouters', { webtopUsername: e.target.value })} />
            </Field>
            <Field label="Webtop port">
              <NumberInput min={1} max={65535} value={s.holorouters.webtopPort} onChange={(n) => upd('holorouters', { webtopPort: n })} />
            </Field>
            <Field label="Health check (minutes)">
              <NumberInput min={1} max={60} value={s.holorouters.healthCheckMinutes} onChange={(n) => upd('holorouters', { healthCheckMinutes: n })} />
            </Field>
          </div>
          <Field
            label="Webtop password"
            help={`${data.webtopPasswordSet ? 'Set. ' : 'Not set — lab owners will see the link but no password. '}Shown to lab owners in their lab's credentials; stored encrypted. Every Holorouter uses the same webtop login today.`}
          >
            <div className="flex gap-2">
              <input className="input" type="password" autoComplete="off" value={webtopPassword} placeholder={data.webtopPasswordSet ? '••••••••' : ''} onChange={(e) => setWebtopPassword(e.target.value)} />
              <button
                className="btn-secondary"
                disabled={!webtopPassword}
                onClick={async () => {
                  const ok = await run(() => api.put('/api/admin/settings/webtop-password', { password: webtopPassword }), 'Webtop password saved');
                  if (ok) {
                    setWebtopPassword('');
                    void reload();
                  }
                }}
              >
                Set
              </button>
            </div>
          </Field>
        </Section>

        <Section title="Local accounts" onSave={() => save('auth')}>
          <Toggle
            checked={s.auth.localEnabled}
            onChange={(v) => setS({ ...s, auth: { ...s.auth, localEnabled: v } })}
            label="Allow local username/password sign-in"
            help="Local administrators can always sign in (via “Administrator sign-in”) so a broken IdP can't lock you out."
          />
        </Section>

        <Section
          title="OpenID Connect"
          description={
            <>
              Redirect URI: <code className="text-slate-200">{data.sso.oidcRedirectUri}</code> <CopyButton text={data.sso.oidcRedirectUri} />
            </>
          }
          onSave={async () => {
            if (oidcSecret) {
              await run(() => api.put('/api/admin/settings/oidc-secret', { secret: oidcSecret }));
              setOidcSecret('');
            }
            await save('auth');
          }}
        >
          <Toggle checked={s.auth.oidc.enabled} onChange={(v) => updAuth('oidc', { enabled: v })} label="Enable OIDC sign-in" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Button label">
              <input className="input" value={s.auth.oidc.displayName} onChange={(e) => updAuth('oidc', { displayName: e.target.value })} />
            </Field>
            <Field label="Issuer URL" help="Discovery is read from /.well-known/openid-configuration.">
              <input className="input" value={s.auth.oidc.issuer} onChange={(e) => updAuth('oidc', { issuer: e.target.value })} />
            </Field>
            <Field label="Client ID">
              <input className="input" value={s.auth.oidc.clientId} onChange={(e) => updAuth('oidc', { clientId: e.target.value })} />
            </Field>
            <Field label="Client secret" help={data.oidcSecretSet ? 'A secret is saved; leave blank to keep it.' : undefined}>
              <input className="input" type="password" autoComplete="off" value={oidcSecret} onChange={(e) => setOidcSecret(e.target.value)} />
            </Field>
            <Field label="Scopes">
              <input className="input" value={s.auth.oidc.scopes} onChange={(e) => updAuth('oidc', { scopes: e.target.value })} />
            </Field>
            <Field label="Username claim">
              <input className="input" value={s.auth.oidc.usernameClaim} onChange={(e) => updAuth('oidc', { usernameClaim: e.target.value })} />
            </Field>
            <Field label="Groups claim">
              <input className="input" value={s.auth.oidc.groupsClaim} onChange={(e) => updAuth('oidc', { groupsClaim: e.target.value })} />
            </Field>
            <div />
            <Field label="Admin groups" help="Comma-separated">
              <input className="input" value={listToText(s.auth.oidc.adminGroups)} onChange={(e) => updAuth('oidc', { adminGroups: textToList(e.target.value) })} />
            </Field>
            <Field label="User groups" help="Comma-separated; empty = any authenticated user">
              <input className="input" value={listToText(s.auth.oidc.userGroups)} onChange={(e) => updAuth('oidc', { userGroups: textToList(e.target.value) })} />
            </Field>
          </div>
          <Toggle checked={s.auth.oidc.autoProvision} onChange={(v) => updAuth('oidc', { autoProvision: v })} label="Create portal accounts on first sign-in" />
        </Section>

        <Section
          title="SAML 2.0"
          description={
            <span className="space-y-1">
              <span className="block">
                ACS URL: <code className="text-slate-200">{data.sso.samlAcsUrl}</code> <CopyButton text={data.sso.samlAcsUrl} />
              </span>
              <span className="block">
                SP entity ID: <code className="text-slate-200">{data.sso.samlEntityId}</code> <CopyButton text={data.sso.samlEntityId} />
              </span>
              <span className="block">
                Metadata:{' '}
                <a className="text-blue-300 hover:underline" href={data.sso.samlMetadataUrl} target="_blank" rel="noreferrer">
                  {data.sso.samlMetadataUrl}
                </a>
              </span>
              <span className="block">
                Sign-in must start at the portal. For an IdP app-launcher tile, use{' '}
                <code className="text-slate-200">{data.sso.samlAcsUrl.replace(/\/acs$/, '/login')}</code> as its launch URL; responses the IdP sends
                unprompted are refused.
              </span>
            </span>
          }
          onSave={() => save('auth')}
        >
          <Toggle checked={s.auth.saml.enabled} onChange={(v) => updAuth('saml', { enabled: v })} label="Enable SAML sign-in" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Button label">
              <input className="input" value={s.auth.saml.displayName} onChange={(e) => updAuth('saml', { displayName: e.target.value })} />
            </Field>
            <Field label="IdP SSO URL (redirect binding)">
              <input className="input" value={s.auth.saml.entryPoint} onChange={(e) => updAuth('saml', { entryPoint: e.target.value })} />
            </Field>
            <Field label="IdP entity ID / issuer" help="Optional; verified when set.">
              <input className="input" value={s.auth.saml.idpIssuer} onChange={(e) => updAuth('saml', { idpIssuer: e.target.value })} />
            </Field>
            <Field label="SP entity ID" help="Blank = metadata URL.">
              <input className="input" value={s.auth.saml.spEntityId} onChange={(e) => updAuth('saml', { spEntityId: e.target.value })} />
            </Field>
            <Field label="IdP signing certificate (PEM)" className="sm:col-span-2">
              <textarea className="input min-h-28 font-mono text-xs" value={s.auth.saml.idpCert} onChange={(e) => updAuth('saml', { idpCert: e.target.value })} />
            </Field>
            <Field label="Username attribute">
              <input className="input" value={s.auth.saml.usernameAttribute} onChange={(e) => updAuth('saml', { usernameAttribute: e.target.value })} />
            </Field>
            <Field label="Email attribute">
              <input className="input" value={s.auth.saml.emailAttribute} onChange={(e) => updAuth('saml', { emailAttribute: e.target.value })} />
            </Field>
            <Field label="First name attribute">
              <input className="input" value={s.auth.saml.firstNameAttribute} onChange={(e) => updAuth('saml', { firstNameAttribute: e.target.value })} />
            </Field>
            <Field label="Last name attribute">
              <input className="input" value={s.auth.saml.lastNameAttribute} onChange={(e) => updAuth('saml', { lastNameAttribute: e.target.value })} />
            </Field>
            <Field label="Groups attribute" className="sm:col-span-2">
              <input className="input" value={s.auth.saml.groupsAttribute} onChange={(e) => updAuth('saml', { groupsAttribute: e.target.value })} />
            </Field>
            <Field label="Admin groups" help="Comma-separated">
              <input className="input" value={listToText(s.auth.saml.adminGroups)} onChange={(e) => updAuth('saml', { adminGroups: textToList(e.target.value) })} />
            </Field>
            <Field label="User groups" help="Comma-separated; empty = any authenticated user">
              <input className="input" value={listToText(s.auth.saml.userGroups)} onChange={(e) => updAuth('saml', { userGroups: textToList(e.target.value) })} />
            </Field>
          </div>
          <Toggle checked={s.auth.saml.autoProvision} onChange={(v) => updAuth('saml', { autoProvision: v })} label="Create portal accounts on first sign-in" />
        </Section>
      </div>
    </div>
  );
}
