import { idleStatus, touchLab } from './idle.js';
import { all, get, nowIso, parseJson, run, tx } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { getSettings } from './settings.js';
import { describeSlot, slotConflicts, type SiteAllocation } from './network.js';
import { audit, notify } from './audit.js';
import {
  buildDay2Params,
  buildNewInstanceParams,
  day2ActionsFor,
  hostsAdded,
  HOLODECK_BASE_HOSTS,
  normalizeDeployOptions,
  usesSharedRoutedNetworks,
  isV9,
  VERSIONS,
  type DeployOptions,
} from './holodeck/catalog.js';
import { ACTIVE_JOB_STATUSES, cancelJob, createJob, onJobComplete, onJobStart, type JobRow, type JobStep } from './holodeck/jobs.js';
import { getRouter, knownManagementNetworks, listRouters, pickRouter, routerProfile, routerServesConfig, usableRouterCount, webtopCredential, webtopUrl, type RouterRow } from './holorouters.js';
import { hasVersion } from './staging.js';
import { readHoloConfig } from './holodeck/files.js';
import { configFilesForSync } from './holodeck/configstore.js';
import { dropWebtopSessions, effectiveWebtopMode } from './webtop-gateway.js';
import fs from 'node:fs';
import path from 'node:path';
import { config as appConfig } from './config.js';
import { consoleLinks, curateCredentials, type Credential, type Endpoint, type RawCredential } from './holodeck/credentials.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface UserRow {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  email: string | null;
  role: 'admin' | 'user';
  auth_source: 'local' | 'oidc' | 'saml';
  enabled: number;
  lab_quota: number | null;
  /** IdP subject for SSO accounts; NULL until the first sign-in links it. */
  external_id?: string | null;
  /** Issuer (OIDC) or entity ID (SAML) of the IdP that external_id belongs to. */
  sso_issuer?: string | null;
  /** JSON array of notice IDs the user chose not to see again. */
  dismissed_notices?: string | null;
}

export interface ConfigRow {
  id: number;
  config_id: string;
  name: string;
  description: string;
  enabled: number;
  entitle_all: number;
  defaults: string;
  placement: string;
  depot_secret: string | null;
  created_at: string;
  updated_at: string;
}

export interface LabRow {
  id: number;
  instance_id: string;
  name: string;
  description: string;
  owner_id: number;
  config_id: number;
  slot: number;
  sites: string;
  deploy_site: 'a' | 'b';
  version: string;
  mode: 'VVF' | 'ManagementOnly' | 'FullStack';
  options: string;
  status: LabStatus;
  power_state: string;
  lease_expires_at: string;
  lease_expired: number;
  warned_level: number;
  last_activity_at: string | null;
  idle_warned: number;
  idle_exempt: number;
  uses_shared_routed: number;
  network: string | null;
  nodes: string | null;
  endpoints: string | null;
  credentials_enc: string | null;
  holorouter_id: number | null;
  last_job_id: string | null;
  error: string | null;
  created_at: string;
  deployed_at: string | null;
  removed_at: string | null;
  /** When the host list in `nodes` was last confirmed by a snapshot. */
  snapshot_at: string | null;
}

export type LabStatus = 'queued' | 'deploying' | 'ready' | 'failed' | 'removing' | 'removed';

export interface DepotSecret {
  buildToken?: string;
  proxy?: { enabled?: boolean; protocol?: string; ip?: string; port?: string; username?: string; password?: string };
  offline?: { ip?: string; port?: string; protocol?: string; username?: string; password?: string };
}

export interface Placement {
  cluster?: string;
  datastore?: string;
  resourcePool?: string;
  portGroup?: string;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getLab(id: number): LabRow | undefined {
  return get<LabRow>('SELECT * FROM labs WHERE id = ?', id);
}

export function getConfig(id: number): ConfigRow | undefined {
  return get<ConfigRow>('SELECT * FROM configs WHERE id = ?', id);
}

export function userQuota(user: Pick<UserRow, 'lab_quota'>): number {
  return user.lab_quota ?? getSettings().capacity.defaultUserQuota;
}

export function activeLabCount(ownerId?: number): number {
  const sql = "SELECT COUNT(*) AS n FROM labs WHERE status <> 'removed'" + (ownerId ? ' AND owner_id = ?' : '');
  return (get<{ n: number }>(sql, ...(ownerId ? [ownerId] : []))?.n ?? 0);
}

/** Labs that can run at once: one per healthy Holorouter, capped by the admin setting. */
export function effectiveCapacity(): number {
  return Math.min(getSettings().capacity.maxActiveLabs, usableRouterCount());
}

export function labRouter(lab: Pick<LabRow, 'holorouter_id'>): RouterRow | undefined {
  return lab.holorouter_id ? getRouter(lab.holorouter_id) : undefined;
}

export function isEntitled(user: UserRow, cfg: ConfigRow): boolean {
  if (user.role === 'admin') return true;
  if (!cfg.enabled) return false;
  if (cfg.entitle_all) return true;
  return Boolean(get('SELECT 1 FROM config_entitlements WHERE config_id = ? AND user_id = ?', cfg.id, user.id));
}

export function activeJobFor(labId: number): JobRow | undefined {
  return get<JobRow>(
    `SELECT * FROM jobs WHERE lab_id = ? AND status IN (${ACTIVE_JOB_STATUSES.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`,
    labId,
    ...ACTIVE_JOB_STATUSES,
  );
}

function deploySite(lab: LabRow): SiteAllocation {
  const sites = parseJson<SiteAllocation[]>(lab.sites, []);
  const s = sites.find((x) => x.site === lab.deploy_site);
  if (!s) throw new Error('Lab has no allocation for its deploy site');
  return s;
}

// ---------------------------------------------------------------------------
// Job environment
// ---------------------------------------------------------------------------

/** Environment variables Holodeck reads in -DeveloperMode instead of prompting. */
export function holodeckEnv(cfg: ConfigRow, lab?: Pick<LabRow, 'holorouter_id'>): Record<string, string> {
  const depot = decrypt<DepotSecret>(cfg.depot_secret, {});
  // The lab's hosts go where its router's capacity profile says (the router's trunk port groups must be the ones the
  // nested hosts use). A router without a profile (the former primary) uses the configuration's own placement.
  const router = lab ? labRouter(lab) : undefined;
  const profile = router ? routerProfile(router) : undefined;
  const placement: Placement = profile
    ? { cluster: profile.cluster, datastore: profile.datastore, resourcePool: profile.resource_pool, portGroup: profile.trunk_a }
    : parseJson<Placement>(cfg.placement, {});
  const target = readHoloConfig(cfg.config_id, 'a').target;
  const env: Record<string, string> = {
    enable_proxy: depot.proxy?.enabled ? 'y' : 'n',
    enable_proxy_auth: depot.proxy?.enabled && depot.proxy.username ? 'y' : 'n',
  };
  const set = (k: string, v: string | null | undefined) => {
    if (v) env[k] = v;
  };
  set('brcm_build_token', depot.buildToken);
  set('proxy_protocol', depot.proxy?.protocol);
  set('proxy_ip', depot.proxy?.ip);
  set('proxy_port', depot.proxy?.port);
  set('proxy_username', depot.proxy?.username);
  set('proxy_password', depot.proxy?.password);
  set('offline_depot_ip', depot.offline?.ip);
  set('offline_depot_port', depot.offline?.port);
  set('offline_depot_protocol', depot.offline?.protocol);
  set('offline_depot_username', depot.offline?.username);
  set('offline_depot_password', depot.offline?.password);
  // A standalone ESXi target has no cluster or resource pool to choose; Holodeck places by datastore and port group.
  if (target.apiType !== 'HostAgent') {
    set('cluster_name', placement.cluster || target.cluster);
    set('resource_pool_name', placement.resourcePool || target.resourcePool);
  }
  set('datastore_name', placement.datastore || target.datastore);
  set('trunk_port_group_name', placement.portGroup || target.portGroup);
  return env;
}

const importStep = (cfg: ConfigRow, site: string): JobStep => ({
  title: `Import Holodeck config ${cfg.config_id} (site ${site})`,
  command: 'HP-ImportConfig',
  params: { ConfigID: cfg.config_id, Site: site },
});

/**
 * Every job's router gets the portal's master copy of the Holodeck configuration first; HP-SyncConfig keeps the
 * router's own state fields (instance binding, precheck flags, state and log files).
 */
export function syncSteps(cfg: Pick<ConfigRow, 'config_id'>, router: RouterRow | undefined): JobStep[] {
  if (!router) return [];
  const files = configFilesForSync(cfg.config_id);
  if (!files.a) throw new HttpError(409, `The portal has no Holodeck configuration files for '${cfg.config_id}'.`);
  return [{ title: `Copy Holodeck config ${cfg.config_id} to ${router.name}`, command: 'HP-SyncConfig', params: { ConfigID: cfg.config_id, Files: files }, redact: ['Files'] }];
}

const snapshotSteps = (lab: Pick<LabRow, 'instance_id' | 'deploy_site'>): JobStep[] => [
  { title: 'Collect lab details', command: 'HP-Snapshot', params: { InstanceID: lab.instance_id, Site: lab.deploy_site }, capture: 'snapshot' },
  { title: 'Check power state', command: 'HP-PowerState', params: { InstanceID: lab.instance_id, Site: lab.deploy_site }, capture: 'power' },
];

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

export interface DeployRequest {
  configId: number;
  name: string;
  description?: string;
  instanceId?: string;
  leaseDays?: number;
  options: DeployOptions;
  ownerId?: number;
  /** Admins may pin a lab to a Holorouter; otherwise the lowest free slot is used. */
  routerId?: number;
}

const DAY_MS = 24 * 3600_000;

/** Two-digit slot, as used in lab names (slot 6 → "06"). */
export function slotTag(slot: number): string {
  return String(slot).padStart(2, '0');
}

const instanceIdTaken = (id: string) => Boolean(get("SELECT 1 FROM labs WHERE instance_id = ? AND status <> 'removed'", id));

/**
 * The instance ID offered when none is given: "s" + the slot (s06), so VM names show the slot too. Only one lab runs
 * per slot, so it is normally free; if someone chose it by hand for another lab, a letter is added (s06b).
 */
export function suggestedInstanceId(slot: number): string {
  const base = `s${slotTag(slot)}`;
  for (const suffix of ['', ...'bcdefghijklmnopqrstuvwxyz']) {
    if (!instanceIdTaken(base + suffix)) return base + suffix;
  }
  for (let i = 0; i < 50; i++) {
    const id = `hp${Math.random().toString(36).slice(2, 8)}`.slice(0, 8);
    if (!instanceIdTaken(id)) return id;
  }
  throw new HttpError(500, 'Could not generate an instance ID');
}

/** The lab's DNS domain from the admin template. */
export function labDnsDomain(template: string, instanceId: string, slot: number): string {
  return template.replaceAll('{slot}', slotTag(slot)).replaceAll('{instance}', instanceId);
}

export function deployPreflight(user: UserRow, cfg: ConfigRow | undefined, options?: DeployOptions, ownerId?: number, routerId?: number) {
  const problems: string[] = [];
  const owner = ownerId && ownerId !== user.id ? get<UserRow>('SELECT * FROM users WHERE id = ?', ownerId) : user;
  if (!owner) problems.push('Owner not found.');
  if (!cfg) problems.push('Configuration not found.');
  else {
    if (!cfg.enabled) problems.push('This configuration is disabled.');
    if (!isEntitled(user, cfg)) problems.push('You are not entitled to deploy from this configuration.');
    const holo = readHoloConfig(cfg.config_id, 'a');
    if (!holo.exists) problems.push(`Holodeck configuration files for '${cfg.config_id}' were not found.`);
    // Instances the portal doesn't manage are found per router by its checks (they block that router).
  }
  if (owner) {
    const quota = userQuota(owner);
    const used = activeLabCount(owner.id);
    if (used >= quota) problems.push(`Lab quota reached (${used} of ${quota}).`);
  }
  const capacity = effectiveCapacity();
  const active = activeLabCount();
  if (active >= capacity) problems.push(`All lab capacity is in use (${active} of ${capacity}).`);
  else if (routerId && !pickRouter(user, routerId)) problems.push('That Holorouter is not available (busy, unhealthy or reserved for administrators).');
  else if (cfg && routerId && !routerServesConfig(getRouter(routerId)!, cfg.id)) problems.push(`That Holorouter belongs to another configuration (its capacity profile is for a different target).`);
  else if (cfg && !pickRouter(user, routerId, undefined, cfg.id)) problems.push(noRouterForConfig(cfg));
  else if (!cfg && !pickRouter(user)) problems.push('No Holorouter is free for a new lab.');
  else if (options?.version && !pickRouter(user, routerId, options.version, cfg?.id)) problems.push(versionProblem(user, options.version, routerId));
  // Supervisor / VCF Automation use Holodeck's fixed 10.100.x networks, but each lab has its own
  // Holorouter now, so they no longer collide.
  return problems;
}

/** Why no router can take a lab of this configuration: none is mapped to it, or all of them are busy. */
function noRouterForConfig(cfg: ConfigRow): string {
  const mapped = listRouters().filter((r) => routerServesConfig(r, cfg.id));
  return mapped.length
    ? `Every Holorouter for ${cfg.name} is in use (${mapped.map((r) => r.name).join(', ')}). Try again when one is free.`
    : `No Holorouter serves ${cfg.name}. An administrator needs to add one with a capacity profile for this configuration.`;
}

/** Why no free router can deploy this version (its installation files are not staged). */
function versionProblem(user: UserRow, version: string, routerId?: number): string {
  const anywhere = listRouters().some((r) => hasVersion(r, version));
  if (user.role !== 'admin') {
    return `VCF ${version} is not available on any free Holorouter right now. Choose another version or ask an administrator.`;
  }
  if (!anywhere) {
    return `No Holorouter has the VCF ${version} installation files. Download them from the Broadcom support portal and place them in /holodeck-runtime/bin/${version} on any Holorouter, then stage them to the others.`;
  }
  return routerId
    ? `VCF ${version} is not staged on that Holorouter. Stage it under Admin → Holorouters first.`
    : `VCF ${version} is not staged on any free Holorouter. Stage it under Admin → Holorouters first.`;
}

/** Version availability for the deploy form: a version is usable if some free router has its files. */
export function versionAvailability(user: UserRow, routerId?: number, configId?: number) {
  return Object.fromEntries(
    VERSIONS.map((v) => [v, Boolean(pickRouter(user, routerId, v, configId))]),
  ) as Record<string, boolean>;
}

export function deployLab(user: UserRow, req: DeployRequest, ip?: string): LabRow {
  const cfg = getConfig(req.configId);
  const options = normalizeDeployOptions(req.options);
  const settings = getSettings();
  const leaseDays = req.leaseDays ?? settings.lease.defaultDays;
  if (!Number.isInteger(leaseDays) || leaseDays < 1 || (leaseDays > settings.lease.maxDays && user.role !== 'admin')) {
    throw new HttpError(400, `Lease must be between 1 and ${settings.lease.maxDays} days`);
  }
  if (req.instanceId && !/^[a-zA-Z0-9]{1,8}$/.test(req.instanceId)) {
    throw new HttpError(400, 'Instance ID must be 1–8 letters or digits');
  }
  // The DNS domain is per lab (from the admin template); only admins may override it.
  if (user.role !== 'admin') delete options.DNSDomain;
  const ownerId = user.role === 'admin' && req.ownerId ? req.ownerId : user.id;
  const pinned = user.role === 'admin' ? req.routerId : undefined;

  const lab = tx(() => {
    const problems = deployPreflight(user, cfg, options, ownerId, pinned);
    if (problems.length) throw new HttpError(409, problems.join(' '));
    const router = pickRouter(user, pinned, options.version, cfg!.id)!;
    const slot = router.slot;
    // Holodeck lower-cases instance IDs internally (config, VM names); match it.
    const instanceId = (req.instanceId || suggestedInstanceId(slot)).toLowerCase();
    if (instanceIdTaken(instanceId)) {
      throw new HttpError(409, `Instance ID '${instanceId}' is already in use`);
    }
    if (!options.DNSDomain) options.DNSDomain = labDnsDomain(settings.network.dnsDomainTemplate, instanceId, slot);
    // Address and VLAN guard: never hand Holodeck networks that overlap blocked or management networks.
    const conflicts = slotConflicts(settings.network, slot, knownManagementNetworks());
    if (conflicts.length) {
      throw new HttpError(409, `${router.name}'s network slot ${slot} can't be used: ${conflicts.join('; ')}. Fix the network pool in Settings (blocked VLANs and networks).`);
    }
    const alloc = describeSlot(settings.network, slot);
    const expires = new Date(Date.now() + leaseDays * DAY_MS).toISOString();
    const res = run(
      `INSERT INTO labs (instance_id, name, description, owner_id, config_id, slot, sites, deploy_site, version, mode, options,
                         status, lease_expires_at, uses_shared_routed, holorouter_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'a', ?, ?, ?, 'queued', ?, ?, ?)`,
      instanceId,
      req.name.trim(),
      (req.description ?? '').trim(),
      ownerId,
      cfg!.id,
      slot,
      JSON.stringify(alloc.sites),
      options.version,
      options.mode,
      JSON.stringify(options),
      expires,
      usesSharedRoutedNetworks(options) ? 1 : 0,
      router.id,
    );
    return getLab(Number(res.lastInsertRowid))!;
  });

  const site = deploySite(lab);
  const params = buildNewInstanceParams(options, lab.instance_id, site);
  const router = labRouter(lab);
  const job = createJob({
    type: 'lab-deploy',
    labId: lab.id,
    routerId: lab.holorouter_id,
    configId: cfg!.id,
    userId: user.id,
    env: holodeckEnv(cfg!, lab),
    steps: [
      ...syncSteps(cfg!, router),
      importStep(cfg!, site.site),
      { title: `Deploy ${options.mode} ${options.version} as instance ${lab.instance_id}`, command: 'New-HoloDeckInstance', params },
      importStep(cfg!, site.site),
      { title: 'Verify deployment', command: 'HP-AssertDeployed', params: { Site: site.site } },
      ...snapshotSteps(lab),
    ],
    display: { lab: lab.name, instanceId: lab.instance_id, router: router?.name, cidr: site.cidr, vlanStart: site.vlanStart, ...options },
  });
  run('UPDATE labs SET last_job_id = ? WHERE id = ?', job.id, lab.id);
  audit(user.id, 'lab.deploy', `lab:${lab.id}`, { instanceId: lab.instance_id, config: cfg!.config_id, options, slot: lab.slot, router: router?.name }, ip);
  return getLab(lab.id)!;
}

/** Re-runs a failed deployment; Holodeck resumes from its state file. */
export function retryDeploy(user: UserRow, lab: LabRow, ip?: string) {
  if (lab.status !== 'failed') throw new HttpError(409, 'Only failed deployments can be retried');
  assertIdle(lab);
  const cfg = getConfig(lab.config_id)!;
  const options = parseJson<DeployOptions>(lab.options, {} as DeployOptions);
  const site = deploySite(lab);
  const job = createJob({
    type: 'lab-deploy',
    labId: lab.id,
    routerId: lab.holorouter_id,
    configId: cfg.id,
    userId: user.id,
    env: holodeckEnv(cfg, lab),
    steps: [
      ...syncSteps(cfg, labRouter(lab)),
      importStep(cfg, site.site),
      { title: `Resume deployment of ${lab.instance_id}`, command: 'New-HoloDeckInstance', params: buildNewInstanceParams(options, lab.instance_id, site) },
      importStep(cfg, site.site),
      { title: 'Verify deployment', command: 'HP-AssertDeployed', params: { Site: site.site } },
      ...snapshotSteps(lab),
    ],
    display: { lab: lab.name, instanceId: lab.instance_id, retry: true },
  });
  run("UPDATE labs SET status = 'queued', error = NULL, last_job_id = ? WHERE id = ?", job.id, lab.id);
  audit(user.id, 'lab.retry', `lab:${lab.id}`, null, ip);
  return job;
}

onJobStart('lab-deploy', (job) => {
  if (job.lab_id) run("UPDATE labs SET status = 'deploying' WHERE id = ? AND status = 'queued'", job.lab_id);
});

onJobComplete('lab-deploy', (job, result, ok) => {
  const lab = job.lab_id ? getLab(job.lab_id) : undefined;
  if (!lab) return;
  if (ok) {
    storeSnapshot(lab, result);
    run("UPDATE labs SET status = 'ready', error = NULL, deployed_at = ? WHERE id = ?", nowIso(), lab.id);
    notify(lab.owner_id, { labId: lab.id, level: 'success', title: `${lab.name} is ready`, message: `Instance ${lab.instance_id} deployed successfully.` });
  } else {
    run("UPDATE labs SET status = 'failed', error = ? WHERE id = ?", job.error ?? 'Deployment failed', lab.id);
    notify(lab.owner_id, { labId: lab.id, level: 'error', title: `${lab.name} failed to deploy`, message: job.error ?? '' });
  }
});

function storeSnapshot(lab: LabRow, result: Record<string, unknown>) {
  const snap = result.snapshot as
    | { nodes?: unknown[]; subnets?: unknown[]; endpoints?: unknown[]; credentials?: RawCredential[]; bgp?: unknown; domain?: string }
    | undefined;
  if (snap) {
    const creds = curateCredentials(snap.credentials ?? [], lab.version);
    run(
      'UPDATE labs SET network = ?, nodes = ?, endpoints = ?, credentials_enc = ?, snapshot_at = ? WHERE id = ?',
      JSON.stringify({ subnets: snap.subnets ?? [], bgp: snap.bgp ?? null, domain: snap.domain ?? null }),
      JSON.stringify(snap.nodes ?? []),
      JSON.stringify(snap.endpoints ?? []),
      encrypt(creds),
      new Date().toISOString(),
      lab.id,
    );
  }
  const power = result.power as { state?: string } | undefined;
  if (power?.state) run('UPDATE labs SET power_state = ? WHERE id = ?', power.state, lab.id);
}

// ---------------------------------------------------------------------------
// Power, refresh, day-2, diagnostics, remove
// ---------------------------------------------------------------------------

export function assertIdle(lab: LabRow) {
  const job = activeJobFor(lab.id);
  if (job) throw new HttpError(409, `Lab is busy (${job.type} job ${job.status})`);
}

function assertReady(lab: LabRow) {
  if (lab.status !== 'ready') throw new HttpError(409, `Lab must be ready (currently ${lab.status})`);
}

/** idle-stop is the portal's own: a graceful shutdown that resumes a suspended lab first. */
export type PowerAction = 'stop' | 'start' | 'force-off' | 'suspend' | 'idle-stop';

export function powerLab(user: UserRow, lab: LabRow, action: PowerAction, reason?: string, ip?: string) {
  assertReady(lab);
  assertIdle(lab);
  if (action === 'start' && lab.lease_expired && user.role !== 'admin') {
    throw new HttpError(403, 'This lab’s lease has expired. Ask an administrator to renew it.');
  }
  if (action === 'force-off' && user.role !== 'admin') throw new HttpError(403, 'Only administrators can force power off');
  if (action === 'idle-stop' && user.role !== 'admin') throw new HttpError(403, 'Not allowed');
  // Holodeck's shutdown logs in to the nested hosts, which can't answer while suspended.
  if ((action === 'stop' || action === 'suspend') && lab.power_state === 'suspended') {
    throw new HttpError(409, action === 'stop' ? 'The lab is suspended. Resume it first, or have an administrator force it off.' : 'The lab is already suspended.');
  }
  const cfg = getConfig(lab.config_id)!;
  const site = lab.deploy_site;
  const target = { InstanceID: lab.instance_id, Site: site };
  const steps: JobStep[] = [importStep(cfg, site)];
  if (action === 'stop') {
    steps.push(
      { title: 'Graceful shutdown', command: 'Stop-HoloDeckInstance', params: { InstanceID: lab.instance_id, site } },
      // Holodeck stops the nested ESX hosts only; the installer VM is the portal's to stop.
      { title: 'Shut down the installer VM', command: 'HP-StopExtraVMs', params: target },
    );
  }
  if (action === 'start') {
    steps.push(
      { title: lab.power_state === 'suspended' ? 'Resume' : 'Power on', command: 'Start-HoloDeckInstance', params: target },
      { title: 'Power on the installer VM', command: 'HP-StartExtraVMs', params: target },
    );
  }
  if (action === 'idle-stop') {
    if (lab.power_state === 'suspended') {
      steps.push(
        { title: 'Resume (Holodeck signs in to the nested hosts to shut them down)', command: 'Start-HoloDeckInstance', params: target },
        { title: 'Resume the installer VM', command: 'HP-StartExtraVMs', params: target },
      );
    }
    steps.push(
      { title: 'Graceful shutdown', command: 'Stop-HoloDeckInstance', params: { InstanceID: lab.instance_id, site } },
      { title: 'Shut down the installer VM', command: 'HP-StopExtraVMs', params: target },
    );
  }
  if (action === 'suspend') steps.push({ title: 'Suspend all lab VMs', command: 'HP-SuspendLab', params: target });
  if (action === 'force-off') steps.push({ title: 'Force power off', command: 'HP-ForcePowerOff', params: target });
  steps.push({ title: 'Check power state', command: 'HP-PowerState', params: target, capture: 'power' });
  const job = createJob({
    type: 'lab-power',
    labId: lab.id,
    routerId: lab.holorouter_id,
    configId: cfg.id,
    userId: user.id,
    env: holodeckEnv(cfg, lab),
    steps,
    display: { lab: lab.name, action, reason: reason ?? null },
  });
  const transitional = { start: 'starting', stop: 'stopping', suspend: 'suspending', 'force-off': 'stopping', 'idle-stop': 'stopping' }[action];
  run('UPDATE labs SET power_state = ?, last_job_id = ? WHERE id = ?', transitional, job.id, lab.id);
  audit(user.id, `lab.power.${action}`, `lab:${lab.id}`, reason ? { reason } : null, ip);
  // Powering a lab on is use: its idle clock restarts (it would otherwise be suspended again right away).
  if (action === 'start') touchLab(lab.id);
  return job;
}

onJobComplete('lab-power', (job, result) => {
  if (!job.lab_id) return;
  const state = (result.power as { state?: string } | undefined)?.state ?? 'unknown';
  run('UPDATE labs SET power_state = ? WHERE id = ?', state, job.lab_id);
});

export function refreshLab(user: UserRow, lab: LabRow, ip?: string) {
  if (!['ready', 'failed'].includes(lab.status)) throw new HttpError(409, `Cannot refresh a lab that is ${lab.status}`);
  assertIdle(lab);
  const cfg = getConfig(lab.config_id)!;
  const steps: JobStep[] = [importStep(cfg, lab.deploy_site)];
  if (lab.status === 'ready') {
    steps.push({ title: 'Sync instance', command: 'Sync-HoloDeckInstance', params: { site: lab.deploy_site, InstanceID: lab.instance_id } });
  }
  steps.push(...snapshotSteps(lab));
  const job = createJob({
    type: 'lab-refresh',
    labId: lab.id,
    routerId: lab.holorouter_id,
    configId: cfg.id,
    userId: user.id,
    env: holodeckEnv(cfg, lab),
    steps,
    display: { lab: lab.name },
  });
  run('UPDATE labs SET last_job_id = ? WHERE id = ?', job.id, lab.id);
  audit(user.id, 'lab.refresh', `lab:${lab.id}`, null, ip);
  return job;
}

onJobComplete('lab-refresh', (job, result, ok) => {
  const lab = job.lab_id ? getLab(job.lab_id) : undefined;
  if (lab && ok) storeSnapshot(lab, result);
});

export function day2Lab(user: UserRow, lab: LabRow, actionId: string, values: Record<string, unknown>, ip?: string) {
  assertReady(lab);
  assertIdle(lab);
  const limits = getSettings().hosts;
  const action = day2ActionsFor(limits).find((a) => a.id === actionId);
  if (!action) throw new HttpError(400, 'Unknown action');
  if (action.v9Only && !isV9(lab.version)) throw new HttpError(400, `${action.label} requires VCF 9.x`);
  if (action.sharedRouted) {
    const other = get<{ name: string }>("SELECT name FROM labs WHERE uses_shared_routed = 1 AND status <> 'removed' AND id <> ? LIMIT 1", lab.id);
    if (other) throw new HttpError(409, `Only one lab at a time may run Supervisor or VCF Automation (in use by '${other.name}').`);
  }
  let params: Record<string, unknown>;
  try {
    params = buildDay2Params(actionId, values, lab.deploy_site, limits);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const adding = hostsAdded(actionId, params);
  if (adding > 0) {
    const site = String(params.Site ?? lab.deploy_site);
    const { count, max, unconfirmed } = labHostBudget(lab, site);
    // After a failed or cancelled expansion nobody knows how many hosts exist until a refresh has looked;
    // admins are exempt from the limit, not from counting correctly.
    if (unconfirmed) {
      throw new HttpError(
        409,
        'An earlier expansion of this lab failed or was cancelled, so its host count must be confirmed first. ' +
          'Refresh the lab (a refresh was started automatically), or ask an administrator to reconcile it.',
      );
    }
    if (user.role !== 'admin' && count + adding > max) {
      throw new HttpError(
        409,
        `Site ${site.toUpperCase()} of this lab has ${count} host(s) and the limit is ${max} per site; ${action.label.toLowerCase()} would add ${adding} ` +
          `(${Math.max(0, max - count)} left). Ask an administrator if you need more.`,
      );
    }
  }
  if (actionId === 'NewHostsCustom') params.InstanceID = lab.instance_id;
  const cfg = getConfig(lab.config_id)!;
  const job = createJob({
    type: 'lab-day2',
    labId: lab.id,
    routerId: lab.holorouter_id,
    configId: cfg.id,
    userId: user.id,
    env: holodeckEnv(cfg, lab),
    steps: [importStep(cfg, lab.deploy_site), { title: action.label, command: 'Update-HoloDeckInstance', params }, ...snapshotSteps(lab)],
    display: { lab: lab.name, action: action.label, ...values, day2Action: actionId, site: params.Site, hostsAdded: adding },
  });
  if (action.sharedRouted) run('UPDATE labs SET uses_shared_routed = 1 WHERE id = ?', lab.id);
  run('UPDATE labs SET last_job_id = ? WHERE id = ?', job.id, lab.id);
  audit(user.id, 'lab.day2', `lab:${lab.id}`, { action: actionId, values }, ip);
  return job;
}

onJobComplete('lab-day2', (job, result, ok) => {
  const lab = job.lab_id ? getLab(job.lab_id) : undefined;
  if (!lab) return;
  if (ok) storeSnapshot(lab, result);
  else reconcileAfterFailedExpansion(job, lab);
  const display = parseJson<{ action?: string }>(job.params, {});
  notify(lab.owner_id, {
    labId: lab.id,
    level: ok ? 'success' : 'error',
    title: `${display.action ?? 'Day-2 operation'} ${ok ? 'completed' : 'failed'} on ${lab.name}`,
    message: ok ? '' : job.error ?? '',
  });
});

export function diagnosticsLab(user: UserRow, lab: LabRow, full: boolean, ip?: string) {
  assertIdle(lab);
  const cfg = getConfig(lab.config_id)!;
  const job = createJob({
    type: 'lab-diagnostics',
    labId: lab.id,
    routerId: lab.holorouter_id,
    configId: cfg.id,
    userId: user.id,
    exclusive: false,
    steps: [importStep(cfg, lab.deploy_site), { title: 'Export error diagnostics', command: 'Export-ErrorDiagnostics', params: full ? { ExportFullErrorStack: true } : {} }],
    display: { lab: lab.name, full },
  });
  audit(user.id, 'lab.diagnostics', `lab:${lab.id}`, null, ip);
  return job;
}

export function removeLab(user: UserRow, lab: LabRow, ip?: string) {
  if (['removing', 'removed'].includes(lab.status)) throw new HttpError(409, `Lab is already ${lab.status}`);
  assertIdle(lab);
  const cfg = getConfig(lab.config_id)!;
  const site = lab.deploy_site;
  const job = createJob({
    type: 'lab-remove',
    labId: lab.id,
    routerId: lab.holorouter_id,
    configId: cfg.id,
    userId: user.id,
    env: { ...holodeckEnv(cfg, lab), inputInstanceId: lab.instance_id },
    answers: [{ match: 'confirm the deletion', value: lab.instance_id }],
    steps: [
      importStep(cfg, site),
      {
        title: `Remove instance ${lab.instance_id}`,
        command: 'Remove-HoloDeckInstance',
        // Never -ResetHoloRouter: it wipes every Holorouter service (GitLab, Authentik, Vault, DNS, k8s) and reboots.
        params: { site, InstanceID: lab.instance_id },
      },
      { title: 'Remove leftover VMs', command: 'HP-RemoveLeftoverVMs', params: { InstanceID: lab.instance_id, Site: site } },
      { title: 'Verify removal', command: 'HP-AssertRemoved', params: { InstanceID: lab.instance_id, Site: site } },
      { title: 'Clear instance binding', command: 'HP-ClearInstanceBinding', params: { ConfigID: cfg.config_id, InstanceID: lab.instance_id } },
    ],
    display: { lab: lab.name, instanceId: lab.instance_id },
  });
  run("UPDATE labs SET status = 'removing', last_job_id = ? WHERE id = ?", job.id, lab.id);
  audit(user.id, 'lab.remove', `lab:${lab.id}`, { instanceId: lab.instance_id }, ip);
  return job;
}

onJobComplete('lab-remove', (job, _result, ok) => {
  const lab = job.lab_id ? getLab(job.lab_id) : undefined;
  if (!lab) return;
  if (ok) {
    run("UPDATE labs SET status = 'removed', removed_at = ?, power_state = 'absent', credentials_enc = NULL WHERE id = ?", nowIso(), lab.id);
    const router = labRouter(lab);
    if (router) void dropWebtopSessions(router);
    notify(lab.owner_id, { labId: lab.id, level: 'info', title: `${lab.name} was removed`, message: `Network slot ${lab.slot} is free again.` });
  } else {
    run("UPDATE labs SET status = 'failed', error = ? WHERE id = ?", `Removal failed: ${job.error ?? 'unknown error'}`, lab.id);
    notify(lab.owner_id, { labId: lab.id, level: 'error', title: `Removing ${lab.name} failed`, message: job.error ?? '' });
  }
});

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

export function extendLease(user: UserRow, lab: LabRow, days: number, ip?: string) {
  const settings = getSettings();
  if (!Number.isInteger(days) || days < 1) throw new HttpError(400, 'Add at least 1 day');
  if (lab.status === 'removed') throw new HttpError(409, 'Lab has been removed');
  const isAdmin = user.role === 'admin';
  if (!isAdmin) {
    if (!settings.lease.usersCanExtend) throw new HttpError(403, 'Lease extensions are disabled; contact an administrator');
    if (lab.lease_expired) throw new HttpError(403, 'Expired leases can only be renewed by an administrator');
  }
  const base = lab.lease_expired ? Date.now() : Math.max(Date.now(), Date.parse(lab.lease_expires_at));
  const next = base + days * DAY_MS;
  if (!isAdmin && next > Date.now() + settings.lease.maxDays * DAY_MS) {
    throw new HttpError(400, `Leases cannot run more than ${settings.lease.maxDays} days from now`);
  }
  run('UPDATE labs SET lease_expires_at = ?, lease_expired = 0, warned_level = 0 WHERE id = ?', new Date(next).toISOString(), lab.id);
  audit(user.id, lab.lease_expired ? 'lab.lease.renew' : 'lab.lease.extend', `lab:${lab.id}`, { days }, ip);
  return getLab(lab.id)!;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * Nested ESX hosts at one site of a lab, against the per-site limit. The last snapshot lists the hosts
 * (names end in the site letter, e.g. c2-esx-03a); a lab without one counts as Holodeck's 4. Hosts that a
 * running day-2 job is still adding are counted too.
 */
export function labHostBudget(lab: LabRow, site: string = lab.deploy_site) {
  const sameSite = (d: { site?: string }) => String(d.site ?? lab.deploy_site).toLowerCase() === site.toLowerCase();
  const nodes = parseJson<{ name: string; type: string }[]>(lab.nodes, []);
  const esx = nodes.filter((n) => n.type === 'ESX_Host');
  const atSite = esx.filter((n) => (/-esx-\d+([a-z])$/i.exec(n.name)?.[1] ?? lab.deploy_site).toLowerCase() === site.toLowerCase()).length;
  let count = Math.max(HOLODECK_BASE_HOSTS, atSite);
  for (const j of all<{ params: string }>(
    `SELECT params FROM jobs WHERE lab_id = ? AND type = 'lab-day2' AND status IN ('queued','running','waiting_input')`,
    lab.id,
  )) {
    const d = parseJson<{ site?: string; hostsAdded?: number }>(j.params, {});
    if (sameSite(d)) count += Number(d.hostsAdded ?? 0);
  }
  // Expansions that failed or were cancelled after the last confirmed host list may have left hosts behind:
  // they keep their reservation until a newer snapshot (refresh, day-2 success) or an admin reconciles.
  let unconfirmed = false;
  for (const j of all<{ params: string }>(
    `SELECT params FROM jobs WHERE lab_id = ? AND type = 'lab-day2' AND status IN ('failed','cancelled') AND finished_at > ?`,
    lab.id,
    lab.snapshot_at ?? '',
  )) {
    const d = parseJson<{ site?: string; hostsAdded?: number }>(j.params, {});
    const n = Number(d.hostsAdded ?? 0);
    if (n > 0 && sameSite(d)) {
      count += n;
      unconfirmed = true;
    }
  }
  return { site, count, max: getSettings().hosts.maxHostsPerSite, unconfirmed };
}

/** A failed/cancelled expansion: start a refresh so the real host count replaces the reservation. */
function reconcileAfterFailedExpansion(job: JobRow, lab: LabRow) {
  const d = parseJson<{ hostsAdded?: number }>(job.params, {});
  if (!(Number(d.hostsAdded ?? 0) > 0) || lab.status !== 'ready') return;
  const user = get<UserRow>('SELECT * FROM users WHERE id = ?', job.user_id ?? lab.owner_id) ?? get<UserRow>('SELECT * FROM users WHERE id = ?', lab.owner_id);
  if (!user) return;
  try {
    const refresh = refreshLab(user, lab);
    audit(null, 'lab.hosts.reconcile-started', `lab:${lab.id}`, { failedJob: job.id, refreshJob: refresh.id }, undefined);
  } catch (err) {
    console.error(`could not start the reconciling refresh for lab ${lab.id}`, err);
  }
}

/** Admin override when a refresh can't confirm the hosts: the current snapshot is accepted as the truth. */
export function reconcileLabHosts(admin: UserRow, lab: LabRow, ip?: string) {
  const budget = labHostBudget(lab);
  run('UPDATE labs SET snapshot_at = ? WHERE id = ?', new Date().toISOString(), lab.id);
  audit(admin.id, 'lab.hosts.reconciled', `lab:${lab.id}`, { reservedCount: budget.count, unconfirmed: budget.unconfirmed }, ip);
}

export function labView(lab: LabRow, opts: { detail?: boolean } = {}) {
  const owner = get<{ username: string; first_name: string; last_name: string }>(
    'SELECT username, first_name, last_name FROM users WHERE id = ?',
    lab.owner_id,
  );
  const cfg = getConfig(lab.config_id);
  const job = activeJobFor(lab.id);
  const endpoints = parseJson<Endpoint[]>(lab.endpoints, []);
  const nodes = parseJson<{ name: string; ip: string; type: string; powerState?: string }[]>(lab.nodes, []);
  const network = parseJson<{ subnets?: unknown[]; bgp?: unknown; domain?: string }>(lab.network, {});
  const base = {
    id: lab.id,
    name: lab.name,
    description: lab.description,
    idle: lab.status === 'removed' ? null : idleStatus(lab, labRouter(lab)),
    instanceId: lab.instance_id,
    owner: owner ? { id: lab.owner_id, username: owner.username, name: `${owner.first_name} ${owner.last_name}`.trim() } : null,
    config: cfg ? { id: cfg.id, name: cfg.name, configId: cfg.config_id } : null,
    slot: lab.slot,
    sites: parseJson<SiteAllocation[]>(lab.sites, []),
    deploySite: lab.deploy_site,
    version: lab.version,
    mode: lab.mode,
    options: parseJson<Record<string, unknown>>(lab.options, {}),
    status: lab.status,
    powerState: lab.power_state,
    lease: { expiresAt: lab.lease_expires_at, expired: Boolean(lab.lease_expired), warnedLevel: lab.warned_level },
    usesSharedRouted: Boolean(lab.uses_shared_routed),
    error: lab.error,
    createdAt: lab.created_at,
    deployedAt: lab.deployed_at,
    removedAt: lab.removed_at,
    activeJob: job ? { id: job.id, type: job.type, status: job.status, startedAt: job.started_at } : null,
    lastJobId: lab.last_job_id,
    hasCredentials: Boolean(lab.credentials_enc),
    links: consoleLinks(endpoints, lab.mode, nodes),
    holorouter: routerSummary(lab),
    nodeCount: nodes.length,
    domain: network.domain ?? null,
  };
  if (!opts.detail) return base;
  if (lab.status !== 'removed') return { ...base, nodes, network, endpoints, hosts: labHostBudget(lab) };
  return { ...base, nodes, network, endpoints };
}

function routerSummary(lab: LabRow) {
  const router = labRouter(lab);
  if (!router) return null;
  return { id: router.id, name: router.name, slot: router.slot, status: router.status, webtopUrl: webtopUrl(router) };
}

export function labCredentials(lab: LabRow): Credential[] {
  return decrypt<Credential[]>(lab.credentials_enc, []);
}

/** The webtop login for the lab's Holorouter (its jump host), when an admin has set it. */
export function labWebtop(lab: LabRow) {
  const router = labRouter(lab);
  const cred = webtopCredential();
  if (!router || lab.status === 'removed') return null;
  // Through the gateway the portal signs the user in to the webtop itself; the password is never shown.
  if (effectiveWebtopMode(router) !== 'direct') return { url: webtopUrl(router), router: router.name, viaPortal: true, username: null, password: null };
  return { url: webtopUrl(router), router: router.name, viaPortal: false, username: cred?.username ?? null, password: cred?.password ?? null };
}

export function canAccessLab(user: UserRow, lab: LabRow) {
  return user.role === 'admin' || lab.owner_id === user.id;
}

export function listLabs(user: UserRow, scope: 'mine' | 'all', includeRemoved = false) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (scope === 'mine' || user.role !== 'admin') {
    where.push('owner_id = ?');
    params.push(user.id);
  }
  if (!includeRemoved) where.push("status <> 'removed'");
  const sql = `SELECT * FROM labs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`;
  return all<LabRow>(sql, ...params).map((l) => labView(l));
}

// ---------------------------------------------------------------------------
// Cancelled jobs and unanswered prompts
// ---------------------------------------------------------------------------

/** Lab state after one of its jobs is cancelled: a cancelled deployment or removal can be retried or removed. */
export function afterJobCancelled(job: Pick<JobRow, 'lab_id' | 'type'>) {
  if (job.lab_id && job.type === 'lab-deploy') run("UPDATE labs SET status = 'failed', error = 'Deployment cancelled' WHERE id = ?", job.lab_id);
  if (job.lab_id && job.type === 'lab-remove') run("UPDATE labs SET status = 'failed', error = 'Removal cancelled' WHERE id = ?", job.lab_id);
  if (job.lab_id && job.type === 'lab-power') run("UPDATE labs SET power_state = 'unknown' WHERE id = ?", job.lab_id);
}

/**
 * Jobs waiting for an answer: the owner is reminded once, and the job is cancelled at the deadline
 * (Settings → Jobs), so an unattended prompt can't hold a lab or a Holorouter forever.
 */
export async function expireStalePrompts(now = Date.now()) {
  const { promptTimeoutHours, promptReminderHours } = getSettings().jobs;
  for (const job of all<JobRow>("SELECT * FROM jobs WHERE status = 'waiting_input'")) {
    const prompt = parseJson<{ index?: number; since?: string; prompt?: string } | null>(job.prompt, null);
    const since = prompt?.since ? Date.parse(prompt.since) : NaN;
    if (!Number.isFinite(since)) continue;
    const hours = (now - since) / 3600_000;
    const lab = job.lab_id ? getLab(job.lab_id) : undefined;
    const who = lab?.owner_id ?? job.user_id;
    if (promptTimeoutHours > 0 && hours >= promptTimeoutHours) {
      try {
        await cancelJob(job.id);
      } catch {
        continue; // moved on meanwhile
      }
      run('UPDATE jobs SET error = ? WHERE id = ?', `Cancelled: no answer within ${promptTimeoutHours} hours`, job.id);
      afterJobCancelled(job);
      audit(null, 'job.prompt-expired', `job:${job.id}`, { hours: promptTimeoutHours }, undefined);
      if (who) {
        notify(who, {
          labId: job.lab_id,
          level: 'warning',
          title: `${lab ? `${lab.name}: ` : ''}job cancelled, no answer`,
          message: `The ${job.type} job waited ${promptTimeoutHours} hours for an answer and was cancelled.`,
          dedupeKey: `prompt-expired:${job.id}`,
        });
      }
    } else if (promptReminderHours > 0 && hours >= promptReminderHours && who) {
      notify(who, {
        labId: job.lab_id,
        level: 'warning',
        title: `${lab ? `${lab.name}: ` : ''}a job is waiting for your answer`,
        message: promptTimeoutHours > 0 ? `It is cancelled if there is no answer within ${promptTimeoutHours} hours of the question.` : 'Open the job to answer it.',
        dedupeKey: `prompt-reminder:${job.id}:${prompt?.index ?? 0}`,
      });
    }
  }
}
