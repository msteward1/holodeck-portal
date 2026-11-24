import { assertPowerCli } from './powercli.js';
import { WEBTOP_ACTIVITY_COMMAND, effectiveIdlePolicy, routerIdlePolicy, touchRouterLab } from './idle.js';
/**
 * Holorouters under management. Each router owns one network slot and hosts at most one lab. The portal runs on
 * its own host (not on a Holorouter) and drives every router alike over SSH with its own key: jobs run there through
 * run-remote-job.sh, and small file reads use `ssh cat`.
 */
import https from 'node:https';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { all, get, nowIso, parseJson, run, tx } from './db.js';
import { audit, notify } from './audit.js';
import { getSecret, getSettings } from './settings.js';
import { describeSlot, slotConflicts, slotCount, type KnownNetwork } from './network.js';
import { createJob, onJobComplete, type JobRow, type JobStep } from './holodeck/jobs.js';
import { readHoloConfig } from './holodeck/files.js';
import { getConfigFile } from './holodeck/configstore.js';
import { HttpError, getConfig, type UserRow } from './labs.js';

import { cachedStaging, hasVersion, refreshRouterStaging, stagingOf, type Staging, type VersionStaging } from './staging.js';
import { effectiveWebtopMode, firewallCommand, gatewayPort, gatewayUrl, hostsPortal, syncRelays } from './webtop-gateway.js';

const execFileP = promisify(execFile);

export type RouterStatus = 'onboarding' | 'deploying' | 'ready' | 'attention' | 'offline' | 'error' | 'removing';

export interface RouterRow {
  id: number;
  name: string;
  address: string;
  mgmt_ip: string | null;
  slot: number;
  is_primary: number;
  origin: 'primary' | 'imported' | 'deployed';
  profile_id: number | null;
  status: RouterStatus;
  vm_name: string | null;
  holodeck_version: string | null;
  inspection: string | null;
  last_seen_at: string | null;
  last_job_id: string | null;
  error: string | null;
  staging: string | null;
  /** Pinned SSH host key, "ssh-ed25519 SHA256:…". */
  host_key: string | null;
  /** Webtop gateway mode chosen for this router; NULL = the default (webtop-gateway.ts). */
  webtop_mode: string | null;
  /** 'closed' while the portal keeps this router's own webtop ports closed (portal-only mode). */
  webtop_firewall: string | null;
  /** JSON idle policy override (idle.ts); NULL = the default. */
  idle_policy: string | null;
  created_at: string;
}

export interface ProfileRow {
  id: number;
  name: string;
  config_id: number;
  datacenter: string;
  cluster: string;
  resource_pool: string;
  folder: string;
  datastore: string;
  mgmt_network: string;
  trunk_a: string;
  trunk_b: string;
  /** JSON {sha256, sha1, subject, validTo} of the vCenter certificate an administrator approved. */
  vcenter_thumbprint: string | null;
  created_at: string;
  updated_at: string;
}

/** Facts reported by HP-RouterInspect on the router. */
export interface Inspection {
  hostname?: string;
  checkedAt?: string;
  holodeckVersion?: string | null;
  cpus?: number;
  memoryGB?: number;
  diskFreeGB?: number;
  nics?: { name: string; present: boolean; state: string; ip: string }[];
  configs?: { file: string; instanceId: string | null; holorouterStatus: string | null }[];
  instances?: string[];
  startupScript?: boolean;
  vlanInterfaces?: number;
  kubernetes?: { reachable: boolean; pods: number; notReady: string[] };
  webtop?: { httpStatus: string; ok: boolean };
  vcenterReachable?: boolean;
}

// ---------------------------------------------------------------------------
// SSH identity
// ---------------------------------------------------------------------------

const keyFile = () => path.join(config.sshDir, 'id_ed25519');

/** The portal's SSH key for secondary Holorouters, created on first start. */
export async function ensureSshKey() {
  fs.mkdirSync(config.sshDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(keyFile())) {
    await execFileP('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'holodeck-portal', '-f', keyFile()]);
  }
  const known = path.join(config.sshDir, 'known_hosts');
  if (!fs.existsSync(known)) fs.writeFileSync(known, '', { mode: 0o600 });
}

export interface ScannedKey {
  type: string;
  fingerprint: string;
}

/** The SSH host keys a server offers, for an administrator to compare with its console before importing it. */
export async function scanHostKeys(address: string): Promise<ScannedKey[]> {
  let stdout = '';
  try {
    ({ stdout } = await execFileP('ssh-keyscan', ['-T', '10', '-t', 'ed25519,ecdsa,rsa', address], { timeout: 20_000 }));
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? '';
  }
  const lines = stdout.split('\n').filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new HttpError(502, `No SSH host key could be read from ${address}. Check the address and that SSH is running.`);
  const tmp = path.join(config.sshDir, `scan-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  try {
    const { stdout: fps } = await execFileP('ssh-keygen', ['-E', 'sha256', '-lf', tmp]);
    return fps
      .trim()
      .split('\n')
      .map((l, i) => ({ type: lines[i].split(' ')[1], fingerprint: l.split(' ')[1] }))
      .sort((a, b) => (a.type === 'ssh-ed25519' ? -1 : b.type === 'ssh-ed25519' ? 1 : 0));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Fills in host_key for routers onboarded before keys were recorded, from the pinned known_hosts. */
export async function backfillHostKeys() {
  const known = path.join(config.sshDir, 'known_hosts');
  for (const r of all<RouterRow>('SELECT * FROM holorouters WHERE host_key IS NULL')) {
    try {
      const { stdout } = await execFileP('ssh-keygen', ['-E', 'sha256', '-l', '-F', r.address, '-f', known]);
      // "192.0.2.81 ED25519 SHA256:…" (one line per key; ed25519 preferred, as onboarding pins it)
      const keys = stdout
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(' '))
        .filter((f) => f.length >= 3 && f[2].startsWith('SHA256:'));
      const k = keys.find((f) => f[1] === 'ED25519') ?? keys[0];
      if (k) run('UPDATE holorouters SET host_key = ? WHERE id = ?', `${k[1] === 'ED25519' ? 'ssh-ed25519' : k[1].toLowerCase()} ${k[2]}`, r.id);
    } catch {
      // not in known_hosts
    }
  }
}

export interface VcenterCert {
  host: string;
  sha256: string;
  sha1: string;
  subject: string;
  issuer: string;
  validTo: string;
  /** The certificate authority that signed it (from vCenter's /certs/download.zip), for strict PowerCLI trust. */
  caPem?: string;
  /** Whether the certificate is issued for the host name Holodeck connects to (needed for strict trust). */
  nameMatches?: boolean;
}

const SYSTEM_CA_BUNDLES = ['/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/certs/ca-certificates.crt'];

/** System CAs plus the approved vCenter's CA, for the router-deploy job's strict vCenter sign-in. */
function writeTrustBundle(profileId: number, caPem: string): string {
  const system = SYSTEM_CA_BUNDLES.find((f) => fs.existsSync(f));
  const dir = path.join(config.dataDir, 'trust');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `profile-${profileId}.pem`);
  fs.writeFileSync(file, `${system ? fs.readFileSync(system, 'utf8').trimEnd() + '\n' : ''}${caPem.trim()}\n`, { mode: 0o644 });
  return file;
}

/** Strict verification of the router-deploy job's own vCenter connection is possible with this approval. */
export function strictTrustReady(cert: VcenterCert | null): boolean {
  return Boolean(cert?.caPem && cert.nameMatches);
}

/**
 * vCenter's trusted roots, published (unauthenticated) at /certs/download.zip; only a root that verifiably signed
 * the certificate the administrator approves is kept, so the download itself needs no trust.
 */
async function fetchSigningCa(host: string, leaf: crypto.X509Certificate): Promise<string | undefined> {
  if (leaf.checkIssued(leaf) && leaf.verify(leaf.publicKey)) return leaf.toString(); // self-signed
  const zip = await new Promise<Buffer>((resolve, reject) => {
    const req = https.get({ host, path: '/certs/download.zip', rejectUnauthorized: false, timeout: 15_000 }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const parts: Buffer[] = [];
      let size = 0;
      res.on('data', (b: Buffer) => {
        size += b.length;
        if (size > 5 * 1024 * 1024) req.destroy(new Error('too large'));
        else parts.push(b);
      });
      res.on('end', () => resolve(Buffer.concat(parts)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
  const file = path.join(os.tmpdir(), `hp-vcca-${crypto.randomUUID()}.zip`);
  fs.writeFileSync(file, zip, { mode: 0o600 });
  try {
    const { stdout } = await execFileP('unzip', ['-p', file, 'certs/lin/*.0'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    for (const pem of stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
      try {
        const ca = new crypto.X509Certificate(pem);
        if (leaf.checkIssued(ca) && leaf.verify(ca.publicKey)) return ca.toString();
      } catch {
        /* not a certificate we can read */
      }
    }
    return undefined;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** The certificate vCenter presents right now (not trusted, only reported) for an administrator to approve. */
export function fetchVcenterCert(host: string): Promise<VcenterCert> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 15_000 }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      if (!c?.fingerprint256) return reject(new HttpError(502, `${host} presented no certificate`));
      const name = (x: Record<string, unknown> | undefined) => Object.entries(x ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
      const base: VcenterCert = { host, sha256: c.fingerprint256, sha1: c.fingerprint, subject: name(c.subject as never), issuer: name(c.issuer as never), validTo: c.valid_to };
      base.nameMatches = tls.checkServerIdentity(host, c) === undefined;
      const leaf = new crypto.X509Certificate(c.raw);
      fetchSigningCa(host, leaf)
        .then((caPem) => resolve({ ...base, ...(caPem ? { caPem } : {}) }))
        .catch(() => resolve(base));
    });
    sock.on('timeout', () => {
      sock.destroy();
      reject(new HttpError(504, `${host}:443 did not answer`));
    });
    sock.on('error', (err) => reject(new HttpError(502, `Could not read the certificate of ${host}: ${err.message}`)));
  });
}

export function portalPublicKey(): string {
  return fs.readFileSync(`${keyFile()}.pub`, 'utf8').trim();
}

function sshArgs(address: string, extra: string[] = []) {
  return [
    '-i', keyFile(),
    '-o', `UserKnownHostsFile=${path.join(config.sshDir, 'known_hosts')}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes',
    // OVA routers run OpenSSH 9.1 (no post-quantum key exchange); the client's per-connection warning is noise here.
    '-o', 'IgnoreUnknown=WarnWeakCrypto', '-o', 'WarnWeakCrypto=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${path.join(config.sshControlDir, 'cm-%C')}`,
    '-o', 'ControlPersist=120',
    ...extra,
    `root@${address}`,
  ];
}

async function sshRun(router: RouterRow, command: string, timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFileP('ssh', [...sshArgs(router.address), command], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// ---------------------------------------------------------------------------
// Lookups and views
// ---------------------------------------------------------------------------

export function getRouter(id: number): RouterRow | undefined {
  return get<RouterRow>('SELECT * FROM holorouters WHERE id = ?', id);
}

export function listRouters(): RouterRow[] {
  return all<RouterRow>('SELECT * FROM holorouters ORDER BY slot');
}

export function getProfile(id: number): ProfileRow | undefined {
  return get<ProfileRow>('SELECT * FROM capacity_profiles WHERE id = ?', id);
}

export function routerProfile(router: Pick<RouterRow, 'profile_id'>): ProfileRow | undefined {
  return router.profile_id ? getProfile(router.profile_id) : undefined;
}

function activeLabOn(routerId: number) {
  return get<{ id: number; name: string; instance_id: string; status: string; owner_id: number }>(
    "SELECT id, name, instance_id, status, owner_id FROM labs WHERE holorouter_id = ? AND status <> 'removed'",
    routerId,
  );
}

function activeJobOn(routerId: number) {
  return get<{ id: string; type: string }>(
    `SELECT id, type FROM jobs WHERE status IN ('queued','running','waiting_input')
       AND (holorouter_id = ? OR params LIKE ? OR params LIKE ?) LIMIT 1`,
    routerId,
    `%"routerId":${routerId},%`,
    `%"routerId":${routerId}}%`,
  );
}

export function webtopUrl(router: RouterRow): string | null {
  if (effectiveWebtopMode(router) !== 'direct') return gatewayUrl(router);
  const host = router.mgmt_ip || router.address;
  return host ? `http://${host}:${getSettings().holorouters.webtopPort}/` : null;
}

/** What blocks or deserves attention on a router, from its last inspection. */
export function evaluate(router: RouterRow, forImport = false) {
  const insp = parseJson<Inspection | null>(router.inspection, null);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!insp) return { blockers: ['The router has not been checked yet.'], warnings };
  const common = commonHoloDeckVersion();
  if (!insp.holodeckVersion) blockers.push('The Holodeck PowerShell module was not found.');
  else if (common && insp.holodeckVersion !== common) {
    warnings.push(`Holodeck ${insp.holodeckVersion} differs from ${common}, which most other routers run.`);
  }
  if (!insp.webtop?.ok) blockers.push(`The webtop is not answering on port 30000 (HTTP ${insp.webtop?.httpStatus || 'no response'}). Lab users need it as their jump host.`);
  if (!insp.kubernetes?.reachable) blockers.push('Kubernetes is not reachable on the router.');
  else if (insp.kubernetes.notReady.length) warnings.push(`Pods not running: ${insp.kubernetes.notReady.join(', ')}`);
  const nic = (n: string) => insp.nics?.find((x) => x.name === n);
  if (!nic('eth1')?.present) blockers.push('eth1 (trunk for site A) is missing.');
  if (!nic('eth2')?.present) warnings.push('eth2 (trunk for site B) is missing; dual-site labs will need it.');
  if (insp.vcenterReachable === false) blockers.push('The router cannot reach vCenter on port 443.');
  if ((insp.diskFreeGB ?? 999) < 20) warnings.push(`Only ${insp.diskFreeGB} GB free on /holodeck-runtime.`);
  const managed = new Set(all<{ instance_id: string }>('SELECT instance_id FROM labs WHERE holorouter_id = ?', router.id).map((r) => r.instance_id));
  const foreign = (insp.instances ?? []).filter((i) => !managed.has(i.toLowerCase()));
  const bound = (insp.configs ?? []).filter((c) => c.instanceId && !managed.has(c.instanceId.toLowerCase()));
  if (foreign.length) blockers.push(`Holodeck instances not managed by the portal exist: ${foreign.join(', ')}.`);
  else if (bound.length) blockers.push(`Holodeck configs are bound to instances the portal doesn't manage: ${bound.map((c) => `${c.file} → ${c.instanceId}`).join(', ')}.`);
  const configured = (insp.configs ?? []).some((c) => c.holorouterStatus === 'Configured') || insp.startupScript || (insp.vlanInterfaces ?? 0) > 0;
  if (forImport && configured) {
    blockers.push(
      'Holodeck has already configured this router\'s lab networks (startup script / holorouterStatus), possibly for another CIDR. Reset it outside the portal (Reset-HoloRouter) before importing.',
    );
  }
  return { blockers, warnings };
}

export function routerView(router: RouterRow) {
  const profile = routerProfile(router);
  const lab = activeLabOn(router.id);
  const { blockers, warnings } = evaluate(router, router.status === 'onboarding');
  return {
    id: router.id,
    name: router.name,
    address: router.address,
    mgmtIp: router.mgmt_ip,
    slot: router.slot,
    network: describeSlot(getSettings().network, router.slot).sites,

    origin: router.origin,
    status: router.status,
    profile: profile ? { id: profile.id, name: profile.name } : null,
    vmName: router.vm_name,
    holodeckVersion: router.holodeck_version,
    lastSeenAt: router.last_seen_at,
    lastJobId: router.last_job_id,
    error: router.error,
    inspection: parseJson<Inspection | null>(router.inspection, null),
    staging: stagingOf(router),
    stagingJobId: stagingJobOn(router.id)?.id ?? null,
    blockers,
    warnings,
    webtopUrl: webtopUrl(router),
    idle: { policy: routerIdlePolicy(router), effective: effectiveIdlePolicy(router), default: getSettings().idle },
    webtop: {
      gatewayEnabled: getSettings().holorouters.webtopGateway.enabled,
      mode: router.webtop_mode,
      effectiveMode: effectiveWebtopMode(router),
      firewall: router.webtop_firewall,
      gatewayPort: gatewayPort(router),
    },
    hostKey: router.host_key,
    hostKeyShared: sharesHostKey(router),
    /** Also the portal's own host (e.g. the former primary during the move to a portal appliance). */
    hostsPortal: isPortalHost(router),
    lab: lab ? { id: lab.id, name: lab.name, instanceId: lab.instance_id, status: lab.status } : null,
    createdAt: router.created_at,
  };
}

export interface TargetLicense {
  edition: string;
  name?: string;
  evaluation: boolean;
  hoursLeft: number | null;
  writable: boolean;
}

/** The profile's target as last seen: vCenter or a standalone ESXi host (HostAgent), and its licence. */
export function profileTarget(p: ProfileRow): { apiType: string | null; license: TargetLicense | null } {
  const cfg = getConfig(p.config_id);
  const inv = getInventory(p.config_id) as { apiType?: string; license?: TargetLicense } | null;
  const apiType = (cfg ? readHoloConfig(cfg.config_id, 'a').target.apiType : null) ?? inv?.apiType ?? null;
  return { apiType, license: inv?.license ?? null };
}

export function profileView(p: ProfileRow) {
  const cfg = getConfig(p.config_id);
  const target = profileTarget(p);
  return {
    id: p.id,
    name: p.name,
    configId: p.config_id,
    configName: cfg?.name ?? null,
    vcenter: cfg ? readHoloConfig(cfg.config_id, 'a').target.hostname : null,
    datacenter: p.datacenter,
    cluster: p.cluster,
    resourcePool: p.resource_pool,
    folder: p.folder,
    datastore: p.datastore,
    mgmtNetwork: p.mgmt_network,
    trunkA: p.trunk_a,
    trunkB: p.trunk_b,
    vcenterCertificate: parseJson<VcenterCert | null>(p.vcenter_thumbprint, null),
    strictTrustReady: strictTrustReady(parseJson<VcenterCert | null>(p.vcenter_thumbprint, null)),
    targetType: target.apiType === 'HostAgent' ? 'esxi' : target.apiType ? 'vcenter' : null,
    license: target.license,
    routers: all<{ id: number; name: string }>('SELECT id, name FROM holorouters WHERE profile_id = ?', p.id),
    updatedAt: p.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Primary
// ---------------------------------------------------------------------------

/** The Holodeck version most routers run (ties: the newest), as a baseline for the version warning. */
function commonHoloDeckVersion(): string | null {
  const counts = new Map<string, number>();
  for (const r of listRouters()) if (r.holodeck_version) counts.set(r.holodeck_version, (counts.get(r.holodeck_version) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0], undefined, { numeric: true }));
  return ranked[0]?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Placement and capacity
// ---------------------------------------------------------------------------

const USABLE: RouterStatus[] = ['ready'];

/**
 * A router to run Holodeck's configuration cmdlets on (New-/Set-HoloDeckConfig, precheck): the portal itself has
 * no Holodeck. Healthy routers only; idle ones first, then the lowest slot.
 */
export function workbenchRouter(): RouterRow {
  const busy = new Set(
    all<{ r: number }>("SELECT DISTINCT holorouter_id AS r FROM jobs WHERE exclusive = 1 AND status IN ('queued','running','waiting_input') AND holorouter_id IS NOT NULL").map((x) => x.r),
  );
  const candidates = listRouters()
    .filter((r) => ['ready', 'attention'].includes(r.status))
    .sort((a, b) => Number(busy.has(a.id)) - Number(busy.has(b.id)) || Number(a.status !== 'ready') - Number(b.status !== 'ready') || a.slot - b.slot);
  if (!candidates.length) throw new HttpError(409, 'Add a Holorouter first: Holodeck configurations are created and checked on a Holorouter.');
  return candidates[0];
}

function stagingJobOn(routerId: number) {
  return get<{ id: string }>(
    "SELECT id FROM jobs WHERE type = 'router-stage' AND status IN ('queued','running','waiting_input') AND (params LIKE ? OR params LIKE ?) LIMIT 1",
    `%"routerId":${routerId},%`,
    `%"routerId":${routerId}}%`,
  );
}

/**
 * Routers that can take a new lab for this user, lowest slot first. With a version, only routers
 * that have its installation files staged (Holodeck's precheck fails without them).
 */
/**
 * Whether a router can host labs of this configuration: a router with a capacity profile only serves the profile's
 * configuration (its networks and placement belong to that target); one without a profile uses the configuration's
 * own placement and serves any.
 */
export function routerServesConfig(router: Pick<RouterRow, 'profile_id'>, configId: number): boolean {
  const profile = routerProfile(router);
  return !profile || profile.config_id === configId;
}

export function eligibleRouters(user: Pick<UserRow, 'role'>, version?: string, configId?: number): RouterRow[] {
  return listRouters().filter(
    (r) =>
      USABLE.includes(r.status) &&
      r.slot <= slotCount(getSettings().network) &&
      !activeLabOn(r.id) &&
      !stagingJobOn(r.id) &&
      (!version || hasVersion(r, version)) &&
      (configId === undefined || routerServesConfig(r, configId)),
  );
}

/** Routers that count towards capacity: healthy and in the pool. */
export function usableRouterCount(): number {
  const max = slotCount(getSettings().network);
  return listRouters().filter((r) => USABLE.includes(r.status) && r.slot <= max).length;
}

export function pickRouter(user: Pick<UserRow, 'role'>, requested?: number | null, version?: string, configId?: number): RouterRow | null {
  const eligible = eligibleRouters(user, version, configId);
  if (requested) return eligible.find((r) => r.id === requested) ?? null;
  return eligible[0] ?? null;
}

/**
 * Management networks the portal can see, which lab networks must never overlap (address guard): the portal host's eth0
 * subnet and every router's management address.
 */
export function knownManagementNetworks(): KnownNetwork[] {
  const known: KnownNetwork[] = [];
  const eth0 = os.networkInterfaces().eth0?.find((a) => a.family === 'IPv4');
  if (eth0?.cidr) {
    // Show the network, not the host: 192.0.2.79/24 -> 192.0.2.0/24.
    const [ip, bits] = eth0.cidr.split('/');
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    const n = (ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0) & mask;
    known.push({ cidr: `${[24, 16, 8, 0].map((sh) => (n >>> sh) & 255).join('.')}/${bits}`, label: "the portal's management network" });
  }
  for (const r of listRouters()) {
    if (r.mgmt_ip) known.push({ cidr: `${r.mgmt_ip}/32`, label: `${r.name}'s management address` });
  }
  return known;
}

/** Lowest free slot whose networks clear the management networks, including the new router's own address. */
function freeSlot(address?: string): number {
  const net = getSettings().network;
  const used = new Set(listRouters().map((r) => r.slot));
  const known = knownManagementNetworks();
  if (address && /^\d+\.\d+\.\d+\.\d+$/.test(address)) known.push({ cidr: `${address}/32`, label: 'the new router’s address' });
  const blocked: string[] = [];
  for (let s = 1; s <= slotCount(net); s++) {
    if (used.has(s)) continue;
    const conflicts = slotConflicts(net, s, known);
    if (!conflicts.length) return s;
    blocked.push(`slot ${s}: ${conflicts.join('; ')}`);
  }
  throw new HttpError(
    409,
    blocked.length
      ? `No free network slot is clear of the management networks (${blocked.join(' · ')}). Add them to Blocked networks in Settings → Network pool so the pool skips them, and widen the pool.`
      : 'Every network slot already has a Holorouter. Widen the CIDR pool in Settings to add more.',
  );
}

// ---------------------------------------------------------------------------
// Capacity profiles and vCenter inventory
// ---------------------------------------------------------------------------

export interface ProfileInput {
  name: string;
  configId: number;
  datacenter: string;
  cluster: string;
  resourcePool?: string;
  folder?: string;
  datastore: string;
  mgmtNetwork: string;
  trunkA: string;
  trunkB: string;
}

export function saveProfile(admin: UserRow, input: ProfileInput, id?: number, ip?: string): ProfileRow {
  if (!getConfig(input.configId)) throw new HttpError(400, 'Configuration not found');
  if (input.trunkA === input.mgmtNetwork) throw new HttpError(400, 'The site A trunk must not be the management network.');
  const values = [
    input.name.trim(), input.configId, input.datacenter, input.cluster, input.resourcePool ?? '', input.folder ?? '',
    input.datastore, input.mgmtNetwork, input.trunkA, input.trunkB,
  ] as const;
  try {
    if (id) {
      const before = getProfile(id);
      if (!before) throw new HttpError(404, 'Profile not found');
      // An approved vCenter certificate belongs to the configuration's vCenter; a different one needs approving again.
      if (before.config_id !== input.configId) run('UPDATE capacity_profiles SET vcenter_thumbprint = NULL WHERE id = ?', id);
      run(
        `UPDATE capacity_profiles SET name = ?, config_id = ?, datacenter = ?, cluster = ?, resource_pool = ?, folder = ?,
           datastore = ?, mgmt_network = ?, trunk_a = ?, trunk_b = ?, updated_at = ? WHERE id = ?`,
        ...values, nowIso(), id,
      );
    } else {
      const res = run(
        `INSERT INTO capacity_profiles (name, config_id, datacenter, cluster, resource_pool, folder, datastore, mgmt_network, trunk_a, trunk_b)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...values,
      );
      id = Number(res.lastInsertRowid);
    }
  } catch (err) {
    if (/UNIQUE/.test((err as Error).message)) throw new HttpError(409, `A profile named '${input.name}' already exists`);
    throw err;
  }
  audit(admin.id, 'profile.save', `profile:${id}`, input, ip);
  return getProfile(id)!;
}

export function deleteProfile(admin: UserRow, id: number, ip?: string) {
  const p = getProfile(id);
  if (!p) throw new HttpError(404, 'Profile not found');
  const users = all<{ name: string }>('SELECT name FROM holorouters WHERE profile_id = ?', id);
  if (users.length) throw new HttpError(409, `Profile is used by: ${users.map((u) => u.name).join(', ')}`);
  run('DELETE FROM capacity_profiles WHERE id = ?', id);
  audit(admin.id, 'profile.delete', `profile:${id}`, { name: p.name }, ip);
}

/** Portal-side jobs load the portal's copy of the configuration (no Holodeck needed); see targetEnv. */
const importConfigStep = (configId: string): JobStep => ({
  title: `Use Holodeck config ${configId}`,
  command: 'HP-UseTarget',
  params: { ConfigID: configId },
});

/** The configuration (with the target credentials) for HP-UseTarget, passed in the job's secret environment. */
function targetEnv(configId: string): Record<string, string> {
  const c = getConfigFile(configId, 'a');
  if (!c) throw new HttpError(409, `The portal has no Holodeck configuration files for '${configId}'.`);
  return { HP_TARGET_CONFIG: Buffer.from(JSON.stringify(c)).toString('base64') };
}

export function refreshInventory(admin: UserRow, configId: number) {
  assertPowerCli();
  const cfg = getConfig(configId);
  if (!cfg) throw new HttpError(404, 'Configuration not found');
  return createJob({
    type: 'vcenter-inventory',
    configId: cfg.id,
    userId: admin.id,
    exclusive: false,
    env: targetEnv(cfg.config_id),
    steps: [importConfigStep(cfg.config_id), { title: 'Read vCenter inventory', command: 'HP-VCenterInventory', capture: 'inventory' }],
    display: { config: cfg.name },
  });
}

onJobComplete('vcenter-inventory', (job, result, ok) => {
  if (!ok || !job.config_id || !result.inventory) return;
  run(
    `INSERT INTO vcenter_inventory (config_id, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(config_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    job.config_id,
    JSON.stringify(result.inventory),
    nowIso(),
  );
});

export function getInventory(configId: number) {
  const row = get<{ data: string; fetched_at: string }>('SELECT data, fetched_at FROM vcenter_inventory WHERE config_id = ?', configId);
  return row ? { fetchedAt: row.fetched_at, ...parseJson<object>(row.data, {}) } : null;
}

// ---------------------------------------------------------------------------
// Onboarding: import an existing router, or deploy one from the OVA
// ---------------------------------------------------------------------------

function assertAddressFree(address: string) {
  if (get('SELECT 1 FROM holorouters WHERE address = ? OR mgmt_ip = ?', address, address)) {
    throw new HttpError(409, `${address} is already under management`);
  }
  if (['localhost', '127.0.0.1', os.hostname()].includes(address)) {
    throw new HttpError(400, 'That is the portal itself, not a Holorouter.');
  }
}

function requireProfile(id: number) {
  const p = getProfile(id);
  if (!p) throw new HttpError(400, 'Capacity profile not found');
  const cfg = getConfig(p.config_id);
  if (!cfg) throw new HttpError(400, 'The profile’s configuration no longer exists');
  return { profile: p, cfg };
}

/**
 * The router to copy a version's installation files from: any healthy router with a complete, BOM-checked copy.
 * Same Holodeck version as the target first (its BOM decides the file names), then the lowest slot. Null if none.
 */
export function stagingSource(version: string, target?: Pick<RouterRow, 'id' | 'holodeck_version'>) {
  const candidates = listRouters()
    .filter((r) => r.id !== target?.id && ['ready', 'attention'].includes(r.status))
    .map((r) => ({ router: r, v: cachedStaging(r)?.versions.find((x) => x.version === version) }))
    .filter((c) => c.v?.status === 'ready' && c.v.esx && c.v.installer)
    .sort(
      (a, b) =>
        Number(a.router.holodeck_version !== target?.holodeck_version) - Number(b.router.holodeck_version !== target?.holodeck_version) ||
        a.router.slot - b.router.slot,
    );
  const c = candidates[0];
  return c ? { router: c.router, files: [{ version, name: c.v!.esx!.name }, { version, name: c.v!.installer!.name }] } : null;
}

/**
 * Installation files across all routers, for the Deploy / Import dialogs and the staging panels: per version the best
 * state any router has, and which routers hold a complete copy (the possible sources).
 */
export function fleetStaging(): { checkedAt: string; versions: (VersionStaging & { sources: string[] })[] } {
  const byVersion = new Map<string, VersionStaging & { sources: string[] }>();
  const rank = { ready: 2, incomplete: 1, missing: 0 } as const;
  for (const r of listRouters()) {
    for (const v of cachedStaging(r)?.versions ?? []) {
      const cur = byVersion.get(v.version);
      const sources = [...(cur?.sources ?? []), ...(v.status === 'ready' ? [r.name] : [])];
      if (!cur || rank[v.status] > rank[cur.status]) byVersion.set(v.version, { ...v, sources });
      else cur.sources = sources;
    }
  }
  const versions = [...byVersion.values()].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return { checkedAt: new Date().toISOString(), versions };
}

/** True when this router is also the portal's own host (the former primary during the move to an appliance). */
export function isPortalHost(router: Pick<RouterRow, 'mgmt_ip' | 'address'>): boolean {
  return hostsPortal(router);
}

/** Versions some router has complete, i.e. that can be staged elsewhere. */
export function stageableVersions(): string[] {
  const out = new Set<string>();
  for (const r of listRouters()) for (const v of cachedStaging(r)?.versions ?? []) if (v.status === 'ready') out.add(v.version);
  return [...out].sort();
}

function checkStageVersions(versions: string[] | undefined) {
  for (const v of versions ?? []) {
    if (!stagingSource(v)) throw new HttpError(400, `No Holorouter has the complete VCF ${v} installation files, so it can't be staged.`);
  }
  return [...new Set(versions ?? [])];
}

export function importRouter(
  admin: UserRow,
  input: { address: string; password: string; profileId?: number | null; name?: string; stageVersions?: string[]; hostKeyFingerprint: string },
  ip?: string,
) {
  const stageVersions = checkStageVersions(input.stageVersions);
  assertAddressFree(input.address);
  // A first router can come before any configuration (which needs a router to be created on), so a profile is optional.
  const profile = input.profileId ? requireProfile(input.profileId).profile : null;
  const router = tx(() => {
    const slot = freeSlot(input.address);
    const name = input.name?.trim() || input.address;
    if (get('SELECT 1 FROM holorouters WHERE name = ?', name)) throw new HttpError(409, `A Holorouter named '${name}' already exists`);
    const res = run(
      `INSERT INTO holorouters (name, address, mgmt_ip, slot, origin, profile_id, status) VALUES (?, ?, ?, ?, 'imported', ?, 'onboarding')`,
      name, input.address, /^\d+\.\d+\.\d+\.\d+$/.test(input.address) ? input.address : null, slot, profile?.id ?? null,
    );
    return getRouter(Number(res.lastInsertRowid))!;
  });
  const job = createJob({
    type: 'router-onboard',
    userId: admin.id,
    exclusive: false,
    env: { HP_ROUTER_PASSWORD: input.password },
    steps: [
      {
        title: `Install the portal key on ${input.address}`,
        command: 'HP-RouterOnboard',
        params: { Address: input.address, PublicKey: portalPublicKey(), HostKeyFingerprint: input.hostKeyFingerprint },
        capture: 'onboard',
      },
      // The OVA ships the same host keys on every router; give this one its own.
      { title: `Give ${input.address} its own SSH host key`, command: 'HP-RenewHostKey', params: { Address: input.address }, capture: 'rekey' },
    ],
    display: { routerId: router.id, router: router.name, address: input.address, import: true, hostKey: input.hostKeyFingerprint, ...(stageVersions.length ? { stageVersions } : {}) },
  });
  run('UPDATE holorouters SET last_job_id = ? WHERE id = ?', job.id, router.id);
  audit(admin.id, 'holorouter.import', `holorouter:${router.id}`, { address: input.address, slot: router.slot, profile: profile?.name ?? null }, ip);
  return { router: getRouter(router.id)!, job };
}

export interface DeployRouterInput {
  profileId: number;
  vmName: string;
  hostname: string;
  ip: string;
  prefix: number;
  gateway: string;
  dnsServer: string;
  dnsDomain: string;
  ntpServer: string;
  password: string;
  gitops: boolean;
  stageVersions?: string[];
}

export function deployRouter(admin: UserRow, input: DeployRouterInput, ip?: string) {
  assertPowerCli();
  assertAddressFree(input.ip);
  const stageVersions = checkStageVersions(input.stageVersions);
  const { profile, cfg } = requireProfile(input.profileId);
  const ova = getSettings().holorouters;
  if (!ova.ovaUrl) throw new HttpError(400, 'Set the Holorouter OVA URL in Settings → Holorouters first.');
  // An appliance is only deployed when its authenticity can be established: an approved SHA-256, or
  // (unless the admin requires a digest) verified HTTPS. And only into a vCenter whose certificate was approved.
  if (!ova.ovaSha256 && (ova.ovaUrl.startsWith('http://') || ova.requireOvaDigest)) {
    throw new HttpError(
      400,
      ova.ovaUrl.startsWith('http://')
        ? 'The OVA URL is plain HTTP, so the OVA must have an approved SHA-256. Enter it (from the Broadcom download page) in Settings → Holorouters.'
        : 'Settings require an approved SHA-256 for the OVA. Enter it (from the Broadcom download page) in Settings → Holorouters.',
    );
  }
  const vcCert = parseJson<VcenterCert | null>(profile.vcenter_thumbprint, null);
  if (!vcCert) {
    throw new HttpError(409, `Approve the vCenter certificate of capacity profile '${profile.name}' first (Holorouters → Capacity profiles), so the deployment can verify vCenter.`);
  }
  // The job's own vCenter sign-in (which carries the vCenter credentials) is verified against the
  // approved vCenter's CA. Only for vCenter targets: standalone ESXi certificates rarely name the host correctly.
  const target = profileTarget(profile);
  if (target.license && !target.license.writable) {
    throw new HttpError(
      409,
      `The ESXi host of profile '${profile.name}' doesn't accept deployments through its API (${target.license.evaluation ? 'its evaluation period has ended' : 'free ESXi licence'}). ` +
        'Deploy the Holorouter OVA on the host yourself, then add it with Import existing.',
    );
  }
  const isVcenter = target.apiType === 'VirtualCenter';
  const strict = ova.strictVcenterTrust && isVcenter && strictTrustReady(vcCert);
  const trustFile = strict ? writeTrustBundle(profile.id, vcCert.caPem!) : null;
  const router = tx(() => {
    const slot = freeSlot(input.ip);
    if (get('SELECT 1 FROM holorouters WHERE name = ? OR vm_name = ?', input.hostname, input.vmName)) {
      throw new HttpError(409, `A Holorouter named '${input.hostname}' or VM '${input.vmName}' already exists`);
    }
    const res = run(
      `INSERT INTO holorouters (name, address, mgmt_ip, slot, origin, profile_id, status, vm_name) VALUES (?, ?, ?, ?, 'deployed', ?, 'deploying', ?)`,
      input.hostname, input.ip, input.ip, slot, profile.id, input.vmName,
    );
    return getRouter(Number(res.lastInsertRowid))!;
  });
  // SSH and the webtop are mandatory on managed routers (jobs run over SSH; the webtop is the lab jump host).
  const properties: Record<string, string> = {
    'network.hostname': input.hostname,
    'network.ip': input.ip,
    'network.mask': String(input.prefix),
    'network.gateway': input.gateway,
    'network.dns_server': input.dnsServer,
    'network.dns_domain': input.dnsDomain,
    'network.ntp_server': input.ntpServer,
    'extra.ssh_enabled': 'True',
    'extra.webtop_enabled': 'True',
    'extra.gitops_enabled': input.gitops ? 'True' : 'False',
  };
  const job = createJob({
    type: 'router-deploy',
    configId: cfg.id,
    userId: admin.id,
    exclusive: false,
    // .NET reads its trust store once per process, so the bundle is set for the whole job (system CAs + vCenter's CA).
    env: { HP_ROUTER_PASSWORD: input.password, ...targetEnv(cfg.config_id), ...(trustFile ? { SSL_CERT_FILE: trustFile } : {}) },
    steps: [
      importConfigStep(cfg.config_id),
      {
        title: ova.ovaSha256 ? 'Download the Holorouter OVA and check its SHA-256' : 'Download the Holorouter OVA',
        command: 'HP-FetchOva',
        params: { Url: ova.ovaUrl, ...(ova.ovaSha256 ? { Sha256: ova.ovaSha256 } : {}), ...(ova.depotCaPem ? { CaPem: ova.depotCaPem } : {}) },
      },
      {
        title: `Deploy Holorouter VM ${input.vmName}`,
        command: 'HP-DeployRouter',
        params: {
          OvaUrl: ova.ovaUrl,
          ...(ova.ovaSha256 ? { OvaSha256: ova.ovaSha256 } : {}),
          VCenterSha256: vcCert.sha256,
          VCenterSha1: vcCert.sha1,
          ...(strict ? { StrictTrust: true } : {}),
          ...(!strict && ova.strictVcenterTrust && isVcenter ? { StrictTrustNote: vcCert.caPem ? 'name' : 'reapprove' } : {}),
          VMName: input.vmName,
          Datacenter: profile.datacenter,
          Cluster: profile.cluster,
          ResourcePool: profile.resource_pool,
          Folder: profile.folder,
          Datastore: profile.datastore,
          MgmtNetwork: profile.mgmt_network,
          TrunkA: profile.trunk_a,
          TrunkB: profile.trunk_b,
          Properties: properties,
        },
      },
      { title: `Wait for ${input.hostname} to finish its first boot`, command: 'HP-WaitRouterReady', params: { Address: input.ip } },
      {
        title: `Onboard ${input.hostname} (portal key and its own SSH host key)`,
        command: 'HP-OnboardDeployedRouter',
        params: { Address: input.ip, VMName: input.vmName, PublicKey: portalPublicKey(), VCenterSha256: vcCert.sha256 },
        capture: 'onboard',
      },
    ],
    display: { routerId: router.id, router: router.name, address: input.ip, vmName: input.vmName, profile: profile.name, ...(stageVersions.length ? { stageVersions } : {}) },
  });
  run('UPDATE holorouters SET last_job_id = ? WHERE id = ?', job.id, router.id);
  audit(admin.id, 'holorouter.deploy', `holorouter:${router.id}`, { ...properties, vmName: input.vmName, slot: router.slot, profile: profile.name }, ip);
  return { router: getRouter(router.id)!, job };
}

function routerIdOf(job: JobRow): number | null {
  const id = parseJson<{ routerId?: number }>(job.params, {}).routerId;
  return typeof id === 'number' ? id : job.holorouter_id;
}

function onboardDone(job: JobRow, result: Record<string, unknown>, ok: boolean) {
  const router = getRouter(routerIdOf(job) ?? 0);
  if (!router) return;
  if (!ok) {
    run("UPDATE holorouters SET status = 'error', error = ? WHERE id = ?", job.error ?? 'Onboarding failed', router.id);
    if (job.user_id) notify(job.user_id, { level: 'error', title: `Holorouter ${router.name} could not be added`, message: job.error ?? '' });
    return;
  }
  const onboard = result.onboard as { hostname?: string; hostKey?: string } | undefined;
  const hostname = onboard?.hostname;
  const hostKey = typeof result.rekey === 'string' ? result.rekey : onboard?.hostKey;
  if (hostKey) run('UPDATE holorouters SET host_key = ? WHERE id = ?', hostKey, router.id);
  // Imported routers default to the address as their name; the router's hostname reads better.
  if (hostname && router.origin === 'imported' && router.name === router.address && !get('SELECT 1 FROM holorouters WHERE name = ?', hostname)) {
    run('UPDATE holorouters SET name = ? WHERE id = ?', hostname, router.id);
  }
  run("UPDATE holorouters SET status = 'onboarding', error = NULL, last_seen_at = ? WHERE id = ?", nowIso(), router.id);
  checkRouter(job.user_id, getRouter(router.id)!, stageVersionsOf(job));
}

function stageVersionsOf(job: JobRow): string[] {
  const v = parseJson<{ stageVersions?: unknown }>(job.params, {}).stageVersions;
  return Array.isArray(v) ? v.map(String) : [];
}
onJobComplete('router-onboard', onboardDone);
onJobComplete('router-deploy', onboardDone);

/** SHA256 fingerprint of an OpenSSH public key line, as ssh-keygen prints it. */
export function sshFingerprint(pubLine: string): string | null {
  const blob = pubLine.trim().split(/\s+/)[1];
  if (!blob) return null;
  return `SHA256:${crypto.createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Host keys known to be the OVA's shipped ones: the portal host's own key if it is a Holorouter, keys a renewal
 * has replaced, and any key two routers present.
 */
function shippedHostKeys(): Set<string> {
  const keys = new Set<string>();
  try {
    const fp = sshFingerprint(fs.readFileSync(config.primaryHostKeyFile, 'utf8'));
    if (fp) keys.add(fp);
  } catch {
    /* not on a Holorouter (tests, development) */
  }
  for (const a of all<{ details: string }>("SELECT details FROM audit WHERE action = 'holorouter.rekey'")) {
    const prev = parseJson<{ previous?: string | null }>(a.details, {}).previous;
    if (prev) keys.add(prev.split(' ').pop()!);
  }
  for (const r of all<{ host_key: string }>('SELECT host_key FROM holorouters WHERE host_key IS NOT NULL GROUP BY host_key HAVING COUNT(*) > 1')) {
    keys.add(r.host_key.split(' ').pop()!);
  }
  return keys;
}

/** The router still presents an OVA-shipped host key, which doesn't identify it. */
export function sharesHostKey(router: RouterRow): boolean {
  return Boolean(router.host_key && shippedHostKeys().has(router.host_key.split(' ').pop()!));
}

/** Gives an onboarded secondary its own SSH host keys (routers onboarded before this existed share the OVA's). */
export function renewHostKey(admin: UserRow, router: RouterRow, ip?: string) {
  if (!['ready', 'attention'].includes(router.status)) throw new HttpError(409, `The router is ${router.status}.`);
  const busy = get<{ type: string }>("SELECT type FROM jobs WHERE (holorouter_id = ? OR json_extract(params, '$.routerId') = ?) AND status IN ('queued','running','waiting_input') LIMIT 1", router.id, router.id);
  if (busy) throw new HttpError(409, `A ${busy.type} job is running on this router; try again when it has finished.`);
  const job = createJob({
    type: 'router-rekey',
    userId: admin.id,
    exclusive: false,
    steps: [{ title: `Give ${router.name} its own SSH host key`, command: 'HP-RenewHostKey', params: { Address: router.address }, capture: 'rekey' }],
    display: { routerId: router.id, router: router.name, address: router.address },
  });
  run('UPDATE holorouters SET last_job_id = ? WHERE id = ?', job.id, router.id);
  audit(admin.id, 'holorouter.rekey', `holorouter:${router.id}`, { previous: router.host_key }, ip);
  return job;
}

onJobComplete('router-rekey', (job, result, ok) => {
  const router = getRouter(routerIdOf(job) ?? 0);
  if (!router) return;
  if (ok && typeof result.rekey === 'string') run('UPDATE holorouters SET host_key = ? WHERE id = ?', result.rekey, router.id);
  if (job.user_id) {
    notify(job.user_id, ok
      ? { level: 'success', title: `${router.name} has its own SSH host key`, message: String(result.rekey ?? '') }
      : { level: 'error', title: `Renewing the SSH host key of ${router.name} failed`, message: job.error ?? '' });
  }
});

/** Runs HP-RouterInspect on the router itself. */
export function checkRouter(userId: number | null, router: RouterRow, stageVersions: string[] = []) {
  const cfg = routerProfile(router) ? getConfig(routerProfile(router)!.config_id) : undefined;
  const vcenter = cfg ? readHoloConfig(cfg.config_id, 'a').target.hostname : null;
  const job = createJob({
    type: 'router-check',
    routerId: router.id,
    userId,
    exclusive: false,
    steps: [{ title: `Check ${router.name}`, command: 'HP-RouterInspect', params: vcenter ? { VCenter: vcenter } : {}, capture: 'inspect' }],
    display: {
      routerId: router.id,
      router: router.name,
      forImport: router.status === 'onboarding',
      ...(stageVersions.length ? { stageVersions } : {}),
    },
  });
  run('UPDATE holorouters SET last_job_id = ? WHERE id = ?', job.id, router.id);
  return job;
}

onJobComplete('router-check', (job, result, ok) => {
  const router = getRouter(routerIdOf(job) ?? 0);
  if (!router) return;
  const forImport = router.status === 'onboarding';
  if (!ok || !result.inspect) {
    run("UPDATE holorouters SET status = ?, error = ? WHERE id = ?", forImport ? 'error' : 'offline', job.error ?? 'Check failed', router.id);
    return;
  }
  const insp = result.inspect as Inspection;
  run('UPDATE holorouters SET inspection = ?, holodeck_version = ?, last_seen_at = ?, error = NULL WHERE id = ?',
    JSON.stringify(insp), insp.holodeckVersion ?? null, nowIso(), router.id);
  const { blockers } = evaluate(getRouter(router.id)!, forImport);
  // A router that fails its onboarding checks stays 'onboarding', so a re-check applies the same checks
  // (moving it to 'attention' would let the next check skip them).
  const next = blockers.length ? (forImport ? 'onboarding' : 'attention') : 'ready';
  run('UPDATE holorouters SET status = ? WHERE id = ?', next, router.id);
  if (forImport && job.user_id) {
    notify(job.user_id, blockers.length
      ? { level: 'warning', title: `Holorouter ${router.name} needs attention`, message: blockers.join(' ') }
      : { level: 'success', title: `Holorouter ${router.name} is ready`, message: `Slot ${router.slot} adds capacity for one lab.` });
  }
  void refreshRouterStaging(getRouter(router.id)!, (cmd) => sshRun(router, cmd, 30_000)).then(() => {
    // Versions chosen in the Deploy / Import dialog are copied once the router has passed its checks.
    const versions = stageVersionsOf(job);
    const current = getRouter(router.id)!;
    if (next !== 'ready' || !versions.length || !job.user_id) return;
    const user = get<UserRow>('SELECT * FROM users WHERE id = ?', job.user_id);
    if (!user) return;
    try {
      stageRouter(user, current, versions);
    } catch (err) {
      notify(user.id, { level: 'error', title: `Could not stage files on ${router.name}`, message: (err as Error).message });
    }
  });
});

// ---------------------------------------------------------------------------
// Staged installation files
// ---------------------------------------------------------------------------

export async function routerStaging(router: RouterRow): Promise<Staging | null> {
  if (!['ready', 'attention', 'onboarding'].includes(router.status)) return cachedStaging(router);
  return refreshRouterStaging(router, (cmd) => sshRun(router, cmd, 30_000));
}

/** Copies the ESX ISO and installer OVA of each version to a router, from routers that have them. */
export function stageRouter(admin: UserRow, router: RouterRow, versions: string[], ip?: string) {
  if (!['ready', 'attention'].includes(router.status)) throw new HttpError(409, `The router is ${router.status}`);
  if (stagingJobOn(router.id)) throw new HttpError(409, 'Files are already being staged on this router.');
  const unique = [...new Set(versions)];
  if (!unique.length) throw new HttpError(400, 'Choose at least one version.');
  // One step per version (versions may come from different routers).
  const steps: JobStep[] = [];
  const sources: Record<string, string> = {};
  for (const version of unique) {
    const src = stagingSource(version, router);
    if (!src) {
      throw new HttpError(409, `No other Holorouter has the complete VCF ${version} files. Download them from the Broadcom support portal and place them in /holodeck-runtime/bin/${version} on any Holorouter.`);
    }
    sources[version] = src.router.name;
    steps.push({
      title: `Stage VCF ${version} on ${router.name} from ${src.router.name}`,
      command: 'HP-StageFiles',
      params: { Address: router.address, Source: src.router.address, Files: src.files },
    });
  }
  const job = createJob({
    type: 'router-stage',
    userId: admin.id,
    exclusive: false,
    steps,
    display: { routerId: router.id, router: router.name, versions: unique, sources },
  });
  audit(admin.id, 'holorouter.stage', `holorouter:${router.id}`, { versions: unique }, ip);
  return job;
}

onJobComplete('router-stage', (job, _result, ok) => {
  const router = getRouter(routerIdOf(job) ?? 0);
  if (!router) return;
  const versions = parseJson<{ versions?: string[] }>(job.params, {}).versions ?? [];
  void refreshRouterStaging(router, (cmd) => sshRun(router, cmd, 30_000)).finally(() => {
    if (!job.user_id) return;
    notify(job.user_id, ok
      ? { level: 'success', title: `Staged VCF ${versions.join(', ')} on ${router.name}`, message: 'Labs of these versions can now be placed on this router.' }
      : { level: 'error', title: `Staging on ${router.name} failed`, message: `${job.error ?? 'Unknown error'} Staging again resumes the copy.` });
  });
});

/** Deletes one version's staged files from a secondary to free disk space. */
export async function unstageVersion(admin: UserRow, router: RouterRow, version: string, ip?: string) {
  if (!/^[0-9]+(\.[0-9]+)*$/.test(version)) throw new HttpError(400, 'Invalid version');
  if (stagingJobOn(router.id)) throw new HttpError(409, 'Files are being staged on this router.');
  const lab = get<{ name: string }>("SELECT name FROM labs WHERE holorouter_id = ? AND version = ? AND status <> 'removed'", router.id, version);
  if (lab) throw new HttpError(409, `Lab '${lab.name}' on this router uses VCF ${version}.`);
  await sshRun(router, `find /holodeck-runtime/bin/${version} -maxdepth 1 -type f -delete`, 60_000);
  audit(admin.id, 'holorouter.unstage', `holorouter:${router.id}`, { version }, ip);
  return refreshRouterStaging(getRouter(router.id)!, (cmd) => sshRun(router, cmd, 30_000));
}

// ---------------------------------------------------------------------------
// Detach / delete
// ---------------------------------------------------------------------------

function assertRemovable(router: RouterRow) {
  const lab = activeLabOn(router.id);
  if (lab) throw new HttpError(409, `Lab '${lab.name}' is on this Holorouter; remove it first.`);
  const job = activeJobOn(router.id);
  if (job) throw new HttpError(409, `A ${job.type} job is still running for this Holorouter.`);
}

export function detachRouter(admin: UserRow, router: RouterRow, deleteVm: boolean, ip?: string) {
  assertRemovable(router);
  const profile = routerProfile(router);
  const cfg = profile ? getConfig(profile.config_id) : undefined;
  if (deleteVm && !cfg) throw new HttpError(400, 'Deleting the VM needs the router’s capacity profile (for vCenter).');
  if (deleteVm) assertPowerCli();
  const steps: JobStep[] = [
    { title: `Remove the portal key from ${router.address}`, command: 'HP-RouterOffboard', params: { Address: router.address, PublicKey: portalPublicKey(), IgnoreErrors: true } },
  ];
  if (deleteVm) {
    steps.push(importConfigStep(cfg!.config_id), {
      title: `Delete VM ${router.vm_name ?? router.mgmt_ip}`,
      command: 'HP-DeleteRouterVM',
      params: router.vm_name ? { VMName: router.vm_name } : { IPAddress: router.mgmt_ip ?? router.address },
    });
  }
  run("UPDATE holorouters SET status = 'removing' WHERE id = ?", router.id);
  const job = createJob({
    type: deleteVm ? 'router-delete' : 'router-detach',
    configId: cfg?.id ?? null,
    userId: admin.id,
    exclusive: false,
    steps,
    ...(deleteVm ? { env: targetEnv(cfg!.config_id) } : {}),
    display: { routerId: router.id, router: router.name, address: router.address, deleteVm },
  });
  run('UPDATE holorouters SET last_job_id = ? WHERE id = ?', job.id, router.id);
  audit(admin.id, deleteVm ? 'holorouter.delete' : 'holorouter.detach', `holorouter:${router.id}`, { name: router.name, address: router.address }, ip);
  return job;
}

function forgetRouter(id: number) {
  tx(() => {
    // Keep removed labs and finished jobs; they just lose the link to the router.
    run('UPDATE labs SET holorouter_id = NULL WHERE holorouter_id = ?', id);
    run('UPDATE jobs SET holorouter_id = NULL WHERE holorouter_id = ?', id);
    run('DELETE FROM holorouters WHERE id = ?', id);
  });
}

function detachDone(job: JobRow, _result: Record<string, unknown>, ok: boolean) {
  const router = getRouter(routerIdOf(job) ?? 0);
  if (!router) return;
  if (ok) forgetRouter(router.id);
  else run("UPDATE holorouters SET status = 'error', error = ? WHERE id = ?", job.error ?? 'Removal failed', router.id);
}
onJobComplete('router-detach', detachDone);
onJobComplete('router-delete', detachDone);

/** Drops a router that failed onboarding or is gone for good, without contacting it. */
export function forgetFailedRouter(admin: UserRow, router: RouterRow, ip?: string) {
  if (activeLabOn(router.id)) throw new HttpError(409, 'A lab is still on this Holorouter.');
  if (activeJobOn(router.id)) throw new HttpError(409, 'A job is still running for this Holorouter.');
  forgetRouter(router.id);
  // A redeployed VM on the same address gets a new host key; drop the old one so it can be imported again.
  execFileP('ssh-keygen', ['-R', router.address, '-f', path.join(config.sshDir, 'known_hosts')]).catch(() => undefined);
  audit(admin.id, 'holorouter.forget', `holorouter:${router.id}`, { name: router.name, address: router.address }, ip);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** Cheap reachability check of secondary routers (no job): marks them offline / back online. */
export async function healthCheck() {
  for (const router of listRouters()) {
    if (!['ready', 'attention', 'offline'].includes(router.status)) continue;
    let reachable = false;
    let webtopSessions = 0;
    try {
      // The reachability probe also counts webtop connections with recent traffic: the lab on this router is in use.
      webtopSessions = Number.parseInt(String(await sshRun(router, WEBTOP_ACTIVITY_COMMAND, 15_000)).trim(), 10) || 0;
      reachable = true;
    } catch {
      reachable = false;
    }
    if (webtopSessions > 0) touchRouterLab(router.id);
    if (reachable) {
      const status = router.status === 'offline' ? (evaluate(router).blockers.length ? 'attention' : 'ready') : router.status;
      run('UPDATE holorouters SET status = ?, last_seen_at = ? WHERE id = ?', status, nowIso(), router.id);
      await syncWebtopFirewall(getRouter(router.id)!);
      // Files may be added or removed by hand; keep the placement view current.
      if (!stagingJobOn(router.id)) await refreshRouterStaging(router, (cmd) => sshRun(router, cmd, 30_000));
    } else if (router.status !== 'offline') {
      run("UPDATE holorouters SET status = 'offline' WHERE id = ?", router.id);
      for (const a of all<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND enabled = 1")) {
        notify(a.id, { level: 'warning', title: `Holorouter ${router.name} is unreachable`, message: `SSH to ${router.address} failed.`, dedupeKey: `router-offline-${router.id}-${router.last_seen_at}` });
      }
    }
  }
  await syncRelays(listRouters());
}

/**
 * Portal-only routers get their webtop ports (and nginx 80/443) closed on the management interface; every other
 * router gets them back if the portal closed them earlier. Re-asserted on each health check, since a reboot
 * resets the router's firewall. Routers the portal never closed are not touched.
 */
export async function syncWebtopFirewall(router: RouterRow) {
  const close = effectiveWebtopMode(router) === 'portal-only';
  if (!close && router.webtop_firewall !== 'closed') return;
  try {
    await sshRun(router, firewallCommand(close), 20_000);
    run('UPDATE holorouters SET webtop_firewall = ? WHERE id = ?', close ? 'closed' : null, router.id);
  } catch (err) {
    console.error(`webtop firewall on ${router.name} failed`, err);
  }
}

/** After the gateway settings changed: every router's firewall and the relays. */
export async function applyAllWebtopModes() {
  for (const r of listRouters()) if (['ready', 'attention'].includes(r.status)) await syncWebtopFirewall(r);
  await syncRelays(listRouters());
}

/** After a router's webtop mode changed: firewall and relays now, not at the next health check. */
export async function applyWebtopMode(router: RouterRow) {
  await syncWebtopFirewall(router);
  await syncRelays(listRouters());
}

let healthTimer: NodeJS.Timeout | null = null;
export function startHealthLoop() {
  if (healthTimer) return;
  const tick = () => healthCheck().catch((err) => console.error('holorouter health check failed', err));
  healthTimer = setInterval(tick, getSettings().holorouters.healthCheckMinutes * 60_000);
  setTimeout(tick, 15_000);
}
export function stopHealthLoop() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

// ---------------------------------------------------------------------------
// Router files (admin pages)
// ---------------------------------------------------------------------------

const HOLO_ROOT = '/holodeck-runtime';

/** Reads a file below /holodeck-runtime on any router; null when missing or unreachable. */
export async function readRouterFile(router: RouterRow, rel: string): Promise<string | null> {
  if (!/^[\w./-]+$/.test(rel) || rel.includes('..')) throw new Error('Invalid path');
  try {
    return await sshRun(router, `cat ${HOLO_ROOT}/${rel} 2>/dev/null || true`);
  } catch {
    return null;
  }
}

export async function listRouterLogs(router: RouterRow): Promise<{ name: string; size: number; modified: string }[]> {
  try {
    const out = await sshRun(router, `cd ${HOLO_ROOT}/logs 2>/dev/null && stat -c '%n|%s|%Y' *.log 2>/dev/null || true`);
    return out.split('\n').filter(Boolean).map((l) => {
      const [name, size, mtime] = l.split('|');
      return { name, size: Number(size), modified: new Date(Number(mtime) * 1000).toISOString() };
    }).sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

export async function tailRouterLog(router: RouterRow, name: string, bytes: number): Promise<string | null> {
  if (!/^[\w.-]+\.log$/.test(name)) throw new HttpError(400, 'Invalid log name');
  try {
    return await sshRun(router, `tail -c ${Math.max(1, bytes)} ${HOLO_ROOT}/logs/${name}`, 30_000);
  } catch {
    return null;
  }
}

/** A secondary's root password is never stored; this is only the webtop login shown to lab owners. */
export function webtopCredential() {
  const password = getSecret('webtop.password');
  return password ? { username: getSettings().holorouters.webtopUsername, password } : null;
}
