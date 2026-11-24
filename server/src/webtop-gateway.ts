/**
 * Webtop gateway: an optional way to open a Holorouter's webtop through the portal.
 *
 *  - Each router gets its own HTTPS port on the portal (GATEWAY_BASE_PORT + slot), so every webtop is a separate
 *    browser origin: content served by one router can't script the portal or another router's desktop.
 *  - nginx asks the portal (auth_request → /api/webtop/authorize) on every request whether the signed-in user
 *    may use that router (admin, or owner of the router's current lab), and the portal answers with the webtop's
 *    Basic-auth header, which nginx adds. Users never see the webtop password; access follows lab ownership.
 *  - nginx reaches each router's webtop through a local relay (socat over the portal's host-key-pinned SSH, a child
 *    process the portal supervises), because every Holorouter ships the same webtop TLS key and plain HTTP would
 *    cross the management network.
 *  - "portal-only" additionally closes the router's own webtop ports (and nginx 80/443, which also serves
 *    webtop.vcf.lab) on its management interface. Not offered on a router that also hosts the portal.
 *
 * Everything is opt-in: with the gateway off, or a router in 'direct' mode, nothing changes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { getSecret, getSettings } from './settings.js';

const execFileP = promisify(execFile);

export const GATEWAY_BASE_PORT = 8440;
export const GATEWAY_MAX_SLOT = 32;
const RELAY_BASE_PORT = 31000;
const UNIT = 'holodeck-portal-webtop';

export type WebtopMode = 'direct' | 'portal' | 'portal-only';
export const WEBTOP_MODES: WebtopMode[] = ['direct', 'portal', 'portal-only'];

export interface GatewayRouter {
  id: number;
  name: string;
  address: string;
  slot: number;
  status: string;
  mgmt_ip?: string | null;
  webtop_mode?: string | null;
}

/** The router is also the portal's own host (e.g. a former primary during the move to a portal appliance). */
export function hostsPortal(router: Pick<GatewayRouter, 'address'> & { mgmt_ip?: string | null }): boolean {
  const own = Object.values(os.networkInterfaces()).flat().map((a) => a?.address).filter(Boolean);
  return own.includes(router.mgmt_ip ?? '\0') || own.includes(router.address) || ['localhost', '127.0.0.1', os.hostname()].includes(router.address);
}

/** The mode a router actually runs in: 'direct' while the gateway is off. */
export function effectiveWebtopMode(router: GatewayRouter): WebtopMode {
  const gw = getSettings().holorouters.webtopGateway;
  // Enabled but not set up (no token: a development or test host): nothing can be proxied, so direct.
  if (!gw.enabled || !gatewayInstalled()) return 'direct';
  let mode = (WEBTOP_MODES as string[]).includes(router.webtop_mode ?? '') ? (router.webtop_mode as WebtopMode) : gw.defaultMode;
  if (router.slot < 1 || router.slot > GATEWAY_MAX_SLOT) mode = 'direct';
  // Closing 80/443 on the portal's own host would take the portal down.
  if (mode === 'portal-only' && hostsPortal(router)) mode = 'portal';
  return mode;
}

export function gatewayPort(router: Pick<GatewayRouter, 'slot'>): number {
  return GATEWAY_BASE_PORT + router.slot;
}

/** The port nginx proxies to for this router: its relay. */
export function upstreamPort(router: Pick<GatewayRouter, 'slot'>): number {
  return RELAY_BASE_PORT + router.slot;
}

export function gatewayUrl(router: GatewayRouter): string {
  const host = new URL(config.publicUrl).hostname;
  return `https://${host}:${gatewayPort(router)}/`;
}

function tokenFile() {
  return path.join(config.etcDir, 'webtop-gateway.token');
}

/** Shared secret nginx sends with its authorize sub-requests; without the file the gateway is not installed. */
export function gatewayToken(): string | null {
  try {
    const t = fs.readFileSync(tokenFile(), 'utf8').trim();
    return t.length >= 32 ? t : null;
  } catch {
    return null;
  }
}

export function gatewayInstalled(): boolean {
  return gatewayToken() !== null;
}

export function tokenMatches(presented: string | undefined): boolean {
  const expected = gatewayToken();
  if (!expected || !presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The Basic-auth header nginx adds for the webtop (the login is the same on every router today). */
export function webtopAuthorization(): string | null {
  const password = getSecret('webtop.password');
  if (!password) return null;
  const user = getSettings().holorouters.webtopUsername;
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Relays (systemd template units) and the router firewall
// ---------------------------------------------------------------------------

function relayDir() {
  // The portal's unit has /etc read-only (ProtectSystem=full); relay settings live with its data.
  return path.join(config.dataDir, 'webtop');
}

function relayEnv(router: GatewayRouter) {
  return `ADDRESS=${router.address}\nLOCAL_PORT=${upstreamPort(router)}\nSSH_DIR=${config.sshDir}\n`;
}

/**
 * How relays run: 'systemd' (template unit, survives portal restarts), 'process' (children of the portal, supervised
 * here; containers have no systemd) or 'off' (tests).
 */
const relayMode = (): 'systemd' | 'process' | 'off' => config.relayMode;

async function systemctl(...args: string[]) {
  if (relayMode() !== 'systemd') return;
  await execFileP('systemctl', args, { timeout: 30_000 });
}

/** Relays as child processes (process mode): restarted when they exit, until they're no longer wanted. */
const children = new Map<string, { env: string; child: ChildProcess | null; stopped: boolean }>();

function parseEnv(env: string): Record<string, string> {
  return Object.fromEntries(env.split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
}

function startChild(id: string, env: string) {
  const entry = children.get(id) ?? { env, child: null, stopped: false };
  entry.env = env;
  entry.stopped = false;
  children.set(id, entry);
  const e = parseEnv(env);
  const ssh = [
    'ssh', '-i', `${e.SSH_DIR}/id_ed25519`, '-o', `UserKnownHostsFile=${e.SSH_DIR}/known_hosts`, '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes', '-o', 'IgnoreUnknown=WarnWeakCrypto', '-o', 'WarnWeakCrypto=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30',
    '-o', 'LogLevel=ERROR', `root@${e.ADDRESS}`, 'socat', 'STDIO', 'TCP\\:127.0.0.1\\:30000',
  ].join(' ');
  const child = spawn('socat', [`TCP-LISTEN:${e.LOCAL_PORT},bind=127.0.0.1,fork,reuseaddr`, `EXEC:${ssh}`], { stdio: 'ignore' });
  entry.child = child;
  child.on('exit', () => {
    if (entry.child !== child) return;
    entry.child = null;
    if (!entry.stopped) setTimeout(() => !entry.stopped && !entry.child && startChild(id, entry.env), 5000).unref();
  });
  child.on('error', (err) => console.error(`webtop relay ${id} failed to start`, err));
}

function stopChild(id: string) {
  const entry = children.get(id);
  if (!entry) return;
  entry.stopped = true;
  entry.child?.kill('SIGTERM');
  children.delete(id);
}

/** Starts, restarts or stops one relay in whichever mode is configured. */
async function relay(id: string, action: 'start' | 'restart' | 'stop', env?: string) {
  if (relayMode() === 'process') {
    if (action === 'stop') return stopChild(id);
    if (action === 'restart') stopChild(id);
    if (!children.get(id)?.child) startChild(id, env ?? fs.readFileSync(path.join(relayDir(), `${id}.env`), 'utf8'));
    return;
  }
  if (action === 'stop') return systemctl('disable', '--now', `${UNIT}@${id}.service`);
  await systemctl(action, `${UNIT}@${id}.service`);
  await systemctl('enable', `${UNIT}@${id}.service`);
}

/**
 * Makes the relays match the routers' modes: one per secondary that uses the gateway, none otherwise.
 * Idempotent; called at start-up, by the health loop and when a mode, address or lab owner changes.
 */
export async function syncRelays(routers: GatewayRouter[]) {
  const dir = relayDir();
  const wanted = new Map<string, string>();
  for (const r of routers) {
    if (['ready', 'attention', 'offline'].includes(r.status) && effectiveWebtopMode(r) !== 'direct') wanted.set(String(r.id), relayEnv(r));
  }
  if (!wanted.size && !fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const present = fs.readdirSync(dir).filter((f) => f.endsWith('.env')).map((f) => f.slice(0, -4));
  for (const id of present) {
    if (wanted.has(id)) continue;
    await relay(id, 'stop').catch((err) => console.error(`stopping webtop relay ${id} failed`, err));
    fs.rmSync(path.join(dir, `${id}.env`), { force: true });
  }
  for (const [id, env] of wanted) {
    const file = path.join(dir, `${id}.env`);
    const changed = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== env;
    if (changed) fs.writeFileSync(file, env, { mode: 0o600 });
    await relay(id, changed ? 'restart' : 'start', env).catch((err) => console.error(`starting webtop relay ${id} failed`, err));
  }
}

/**
 * Ends every open webtop session on a router (ownership changed, lab removed): restarting the relay drops its
 * connections.
 */
export async function dropWebtopSessions(router: GatewayRouter) {
  if (effectiveWebtopMode(router) === 'direct') return;
  await relay(String(router.id), 'restart').catch((err) => console.error(`restarting webtop relay ${router.id} failed`, err));
}

const FW_SPEC = '-i eth0 -p tcp -m multiport --dports 80,443,30000,30001 -m comment --comment holodeck-portal-webtop -j DROP';

/**
 * Shell command for a secondary that opens or closes its webtop to the management network. Uses the raw table so
 * the rule applies before Kubernetes' NodePort translation. Removing it restores Holodeck's own behaviour.
 */
export function firewallCommand(close: boolean): string {
  return close
    ? `iptables -t raw -C PREROUTING ${FW_SPEC} 2>/dev/null || iptables -t raw -I PREROUTING 1 ${FW_SPEC}; echo closed`
    : `while iptables -t raw -D PREROUTING ${FW_SPEC} 2>/dev/null; do :; done; echo open`;
}
