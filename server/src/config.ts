import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(here, '..', '..');

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  host: env('HP_HOST', '127.0.0.1'),
  port: Number(env('HP_PORT', '3080')),
  /** Public base URL users reach the portal on; used for SSO redirects and secure cookies. */
  publicUrl: env('HP_PUBLIC_URL', 'https://holodeck.example.com').replace(/\/+$/, ''),
  dataDir: env('HP_DATA_DIR', '/var/lib/holodeck-portal'),
  holodeckRoot: env('HP_HOLODECK_ROOT', '/holodeck-runtime'),
  psDir: env('HP_PS_DIR', path.join(appRoot, 'server', 'ps')),
  webDist: env('HP_WEB_DIST', path.join(appRoot, 'web', 'dist')),
  /** The user and administrator guides (standalone HTML, also shown in the Documentation tab). */
  /** This Holorouter's own SSH host key: the OVA's shipped key, used to recognise routers that still have it. */
  primaryHostKeyFile: env('HP_PRIMARY_HOST_KEY', '/etc/ssh/ssh_host_ed25519_key.pub'),
  /** Portal configuration (portal.env, TLS, webtop gateway token and relays). */
  etcDir: env('HP_ETC_DIR', '/etc/holodeck-portal'),
  docsDir: env('HP_DOCS_DIR', path.join(appRoot, 'docs')),
  pwsh: env('HP_PWSH', '/usr/bin/pwsh'),
  /** Portal SSH key and known_hosts for secondary Holorouters (defaults under the data dir). */
  sshDir: env('HP_SSH_DIR', ''),
  /** SSH connection-sharing sockets: temporary, kept out of the data folder (backups can't copy sockets). */
  sshControlDir: env('HP_SSH_CONTROL_DIR', ''),
  /** When false, jobs run as plain child processes instead of transient systemd units (dev/test only). */
  useSystemdRun: env('HP_SYSTEMD_RUN', '1') === '1',
  /** Webtop gateway relays: systemd template units, child processes (containers), or off (tests). */
  relayMode: env('HP_RELAY_MODE', env('HP_SYSTEMD_RUN', '1') === '1' ? 'systemd' : 'off') as 'systemd' | 'process' | 'off',
  sessionTtlHours: Number(env('HP_SESSION_TTL_HOURS', '12')),
  logLevel: env('HP_LOG_LEVEL', 'info'),
};

if (!config.sshDir) config.sshDir = path.join(config.dataDir, 'ssh');
if (!config.sshControlDir) config.sshControlDir = path.join(os.tmpdir(), 'holodeck-portal-ssh');
fs.mkdirSync(config.sshControlDir, { recursive: true, mode: 0o700 });
fs.chmodSync(config.sshControlDir, 0o700);
// Earlier versions kept the sockets in the SSH folder: remove leftovers (harmless, but they break file copies).
try {
  for (const f of fs.readdirSync(config.sshDir)) {
    if (f.startsWith('cm-') && !fs.lstatSync(path.join(config.sshDir, f)).isFile()) fs.rmSync(path.join(config.sshDir, f), { force: true });
  }
} catch {
  /* no SSH folder yet */
}

/** The portal's release version (server/package.json; container images can override it with HP_VERSION). */
export const APP_VERSION: string = (() => {
  if (process.env.HP_VERSION) return process.env.HP_VERSION;
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, 'server', 'package.json'), 'utf8')).version ?? 'dev';
  } catch {
    return 'dev';
  }
})();

/** The git commit the build came from: HP_COMMIT (container builds), else the checkout's HEAD (host installs). */
export const APP_COMMIT: string | null = (() => {
  if (process.env.HP_COMMIT) return process.env.HP_COMMIT.slice(0, 12);
  try {
    let head = fs.readFileSync(path.join(appRoot, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) head = fs.readFileSync(path.join(appRoot, '.git', head.slice(5)), 'utf8').trim();
    return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 12) : null;
  } catch {
    return null;
  }
})();

/** How the portal is installed: the Photon appliance, a plain container, or directly on a host. */
export const FORM_FACTOR: 'appliance' | 'container' | 'host' = (() => {
  if (process.env.HP_FORM_FACTOR === 'appliance' || fs.existsSync(path.join(config.etcDir, '.appliance'))) return 'appliance';
  if (process.env.HP_FORM_FACTOR === 'container' || fs.existsSync('/.dockerenv') || process.env.HP_RELAY_MODE === 'process') return 'container';
  return 'host';
})();

/** The copyright line from the LICENSE file (shipped with every build), so it is written in one place only. */
export const COPYRIGHT: string = (() => {
  try {
    const line = fs.readFileSync(path.join(appRoot, 'LICENSE'), 'utf8').split('\n').find((l) => /^Copyright/i.test(l.trim()));
    if (line) return line.trim();
  } catch {
    /* no LICENSE yet */
  }
  return 'Copyright (c) 2026 the Holodeck Portal contributors';
})();

/** Third-party notices shipped with the build (THIRD_PARTY_NOTICES.md at the top of the tree), if present. */
export const NOTICES_FILE = ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES'].map((f) => path.join(appRoot, f)).find((f) => fs.existsSync(f)) ?? null;

/** The public repository (About, release links). */
export const REPOSITORY_URL = process.env.HP_REPOSITORY_URL || 'https://github.com/msteward1/holodeck-portal';

export type AppConfig = typeof config;
