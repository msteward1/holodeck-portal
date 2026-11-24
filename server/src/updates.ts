/**
 * Portal updates (About → Updates). Releases are published on GitLab (test phase) or GitHub as a signed manifest, its
 * signature and the container image (docker save, gzip). The portal checks for a newer release, downloads it into
 * its data folder and verifies it, then asks the appliance's updater to install it. The updater runs on the host,
 * outside the container, and verifies everything again with its own trusted keys before it touches anything
 * (deploy/appliance/updater.py), so neither a compromised portal nor a compromised release site can install an
 * image that wasn't signed by the release key. Offline sites upload the same files as one bundle.
 *
 * Shared folder (the appliance mounts it at /data/portal/lib/updates):
 *   staged/<version>/   manifest.json, manifest.json.sig, the image file     (written by the portal)
 *   request.json        { version }                                         (portal → updater)
 *   status.json         the updater's progress and result                   (updater → portal)
 *   host.json           updater version and the key IDs the host trusts     (updater → portal)
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { promisify } from 'node:util';
import { z } from 'zod';
import { APP_VERSION, FORM_FACTOR, appRoot, config } from './config.js';
import { all, get } from './db.js';
import { notify } from './audit.js';
import { getSecret, getSettings } from './settings.js';
import { HttpError } from './labs.js';

const execFileP = promisify(execFile);
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_IMAGE_BYTES = 4 * 1024 ** 3;

export const updatesDir = () => path.join(config.dataDir, 'updates');
const stagedDir = (v: string) => path.join(updatesDir(), 'staged', v);

// ---------------------------------------------------------------------------
// Versions, manifests, signatures
// ---------------------------------------------------------------------------

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export const manifestSchema = z.object({
  product: z.literal('holodeck-portal'),
  version: z.string().regex(VERSION_RE),
  published: z.string(),
  /** Oldest installed version this release can update (older ones update in steps). */
  minFromVersion: z.string().regex(VERSION_RE),
  image: z.object({
    file: z.string().regex(/^holodeck-portal-\d+\.\d+\.\d+\.image\.tar\.gz$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive().max(MAX_IMAGE_BYTES),
    id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    tag: z.string().regex(/^holodeck-portal:\d+\.\d+\.\d+$/),
  }),
  notes: z.string().max(20_000).default(''),
});
export type Manifest = z.infer<typeof manifestSchema>;

const signatureSchema = z.object({ keyId: z.string().regex(/^[0-9a-f]{16}$/), signature: z.string().max(200) });

/** The public keys shipped with the portal (release/keys/*.pub), by key ID (first 16 hex of the SPKI's SHA-256). */
export function shippedKeys(): Map<string, crypto.KeyObject> {
  const dir = process.env.HP_RELEASE_KEYS_DIR ?? path.join(appRoot, 'release', 'keys');
  const keys = new Map<string, crypto.KeyObject>();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.pub')) : []) {
    const key = crypto.createPublicKey(fs.readFileSync(path.join(dir, f), 'utf8'));
    keys.set(keyId(key), key);
  }
  return keys;
}

export function keyId(key: crypto.KeyObject): string {
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** Keys this installation accepts: what the appliance's updater trusts, else (no updater) the release key only. */
function acceptedKeys(): Map<string, crypto.KeyObject> {
  const shipped = shippedKeys();
  const host = hostInfo();
  const ids = host ? host.trustedKeyIds : [...shipped.keys()].filter((id) => id === releaseKeyId());
  return new Map([...shipped].filter(([id]) => ids.includes(id)));
}

function releaseKeyId(): string | null {
  const dir = process.env.HP_RELEASE_KEYS_DIR ?? path.join(appRoot, 'release', 'keys');
  const f = path.join(dir, 'release-signing.pub');
  return fs.existsSync(f) ? keyId(crypto.createPublicKey(fs.readFileSync(f, 'utf8'))) : null;
}

/** Checks the manifest's signature against the accepted keys and returns the parsed manifest. */
export function verifyManifest(manifestBytes: Buffer, sigBytes: Buffer, keys = acceptedKeys()): Manifest {
  let sig: z.infer<typeof signatureSchema>;
  try {
    sig = signatureSchema.parse(JSON.parse(sigBytes.toString('utf8')));
  } catch {
    throw new HttpError(400, 'The release signature file is malformed.');
  }
  const key = keys.get(sig.keyId);
  if (!key) throw new HttpError(400, `The release is signed with a key this portal does not trust (key ${sig.keyId}).`);
  if (!crypto.verify(null, manifestBytes, key, Buffer.from(sig.signature, 'base64'))) {
    throw new HttpError(400, 'The release signature is not valid: the manifest was changed or not signed by the release key.');
  }
  try {
    return manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  } catch {
    throw new HttpError(400, 'The release manifest is not valid.');
  }
}

// ---------------------------------------------------------------------------
// Host updater (appliance)
// ---------------------------------------------------------------------------

const hostSchema = z.object({ updaterVersion: z.string(), trustedKeyIds: z.array(z.string()), currentVersion: z.string().optional() });

export function hostInfo(): z.infer<typeof hostSchema> | null {
  try {
    return hostSchema.parse(JSON.parse(fs.readFileSync(path.join(updatesDir(), 'host.json'), 'utf8')));
  } catch {
    return null;
  }
}

const statusSchema = z.object({
  state: z.enum(['running', 'succeeded', 'failed', 'rolled_back']),
  version: z.string(),
  fromVersion: z.string().optional(),
  step: z.string().optional(),
  steps: z.array(z.object({ name: z.string(), status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']) })).default([]),
  message: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type UpdaterStatus = z.infer<typeof statusSchema>;

export function updaterStatus(): UpdaterStatus | null {
  try {
    return statusSchema.parse(JSON.parse(fs.readFileSync(path.join(updatesDir(), 'status.json'), 'utf8')));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Release sources
// ---------------------------------------------------------------------------

interface RemoteRelease {
  version: string;
  url: string | null;
  assets: Map<string, string>;
}

/**
 * Headers for one request. The GitLab token goes only to the configured GitLab origin, and over plain HTTP only when
 * an administrator allowed that (Settings → Updates). Every redirect hop is checked again (see fetchChecked).
 */
export function sourceHeaders(url: string): Record<string, string> {
  const u = getSettings().updates;
  const src = u.source;
  const headers: Record<string, string> = {
    'user-agent': 'holodeck-portal-updater',
    accept: src.type === 'github' ? 'application/vnd.github+json, application/octet-stream' : 'application/json, application/octet-stream',
  };
  if (src.type === 'gitlab') {
    const target = new URL(url);
    const home = new URL(src.url);
    const transportOk = target.protocol === 'https:' || (target.protocol === 'http:' && u.allowInsecureHttp);
    const token = getSecret('updates.gitlabToken');
    if (token && target.origin === home.origin && transportOk) headers['PRIVATE-TOKEN'] = token;
  }
  return headers;
}

const MAX_REDIRECTS = 5;

/**
 * GET with redirects followed by hand, so each hop is checked before anything is sent to it: never from https to
 * http, plain http only to the configured GitLab with plain HTTP allowed, and the token only where sourceHeaders
 * allows it (fetch's own redirect handling would carry a custom header to another origin).
 */
async function fetchChecked(url: string, timeoutMs = 30_000): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertTransport(current);
    const res = await fetch(current, { headers: sourceHeaders(current.href), signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location')!, current);
      if (current.protocol === 'https:' && next.protocol !== 'https:') {
        throw new HttpError(502, `${current.host} redirected to ${next.protocol}//${next.host}, which is not HTTPS; refused.`);
      }
      await res.body?.cancel();
      current = next;
      continue;
    }
    if (!res.ok) throw new HttpError(502, `${current.host} answered ${res.status} for ${current.pathname}`);
    return res;
  }
  throw new HttpError(502, `Too many redirects for ${new URL(url).host}`);
}

/** Plain HTTP is only for the configured GitLab, and only when allowed in Settings → Updates. */
function assertTransport(u: URL) {
  if (u.protocol === 'https:') return;
  const s = getSettings().updates;
  if (u.protocol === 'http:' && s.source.type === 'gitlab' && s.allowInsecureHttp && u.origin === new URL(s.source.url).origin) return;
  throw new HttpError(
    409,
    u.protocol === 'http:' && s.source.type === 'gitlab' && u.origin === new URL(s.source.url).origin
      ? 'The GitLab server uses plain HTTP. Use https://, or allow plain HTTP in Settings → Updates (the token is then sent unencrypted).'
      : `Refused to fetch ${u.protocol}//${u.host}: only HTTPS is allowed.`,
  );
}

export function sourceConfigured(): boolean {
  const src = getSettings().updates.source;
  return src.type === 'gitlab' ? Boolean(src.url && src.project) : /^[\w.-]+\/[\w.-]+$/.test(src.repo);
}

async function listReleases(): Promise<RemoteRelease[]> {
  const src = getSettings().updates.source;
  if (src.type === 'gitlab') {
    const base = `${src.url.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(src.project)}`;
    const list = (await (await fetchChecked(`${base}/releases?per_page=30`)).json()) as {
      tag_name: string;
      upcoming_release?: boolean;
      _links?: { self?: string };
      assets?: { links?: { name: string; url: string; direct_asset_url?: string }[] };
    }[];
    return list
      .filter((r) => !r.upcoming_release)
      .map((r) => ({
        version: r.tag_name.replace(/^v/, ''),
        url: r._links?.self ?? null,
        // The link itself (same server, where the token is sent), not GitLab's redirecting permalink.
        assets: new Map((r.assets?.links ?? []).map((l) => [l.name, l.url])),
      }));
  }
  const list = (await (await fetchChecked(`https://api.github.com/repos/${src.repo}/releases?per_page=30`)).json()) as {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    html_url: string;
    assets: { name: string; browser_download_url: string }[];
  }[];
  return list
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({ version: r.tag_name.replace(/^v/, ''), url: r.html_url, assets: new Map(r.assets.map((a) => [a.name, a.browser_download_url])) }));
}

// ---------------------------------------------------------------------------
// State: last check, download progress
// ---------------------------------------------------------------------------

interface Available {
  version: string;
  manifest: Manifest;
  releaseUrl: string | null;
  manifestUrl: string;
  signatureUrl: string;
  imageUrl: string;
}

const state: {
  checkedAt: string | null;
  checkError: string | null;
  available: Available | null;
  download: { version: string; received: number; total: number; error: string | null; done: boolean; install: boolean; installError?: string } | null;
} = { checkedAt: null, checkError: null, available: null, download: null };

/** Asks the release site for the newest signed release. */
export async function checkForUpdates(): Promise<void> {
  try {
    if (!sourceConfigured()) throw new HttpError(409, 'No update source is configured.');
    const releases = (await listReleases()).filter((r) => VERSION_RE.test(r.version)).sort((a, b) => compareVersions(b.version, a.version));
    let found: Available | null = null;
    for (const r of releases) {
      if (compareVersions(r.version, APP_VERSION) <= 0) break;
      const manifestUrl = r.assets.get(`holodeck-portal-${r.version}.manifest.json`);
      const signatureUrl = r.assets.get(`holodeck-portal-${r.version}.manifest.json.sig`);
      if (!manifestUrl || !signatureUrl) continue;
      const [m, s] = await Promise.all([fetchChecked(manifestUrl), fetchChecked(signatureUrl)]);
      const manifestBytes = Buffer.from(await m.arrayBuffer());
      const sigBytes = Buffer.from(await s.arrayBuffer());
      const manifest = verifyManifest(manifestBytes, sigBytes);
      if (manifest.version !== r.version) continue;
      const imageUrl = r.assets.get(manifest.image.file);
      if (!imageUrl) continue;
      found = { version: r.version, manifest, releaseUrl: r.url, manifestUrl, signatureUrl, imageUrl };
      break;
    }
    state.available = found;
    state.checkError = null;
    if (found) {
      for (const a of all<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND enabled = 1")) {
        notify(a.id, {
          level: 'info',
          title: `Holodeck Portal ${found.version} is available`,
          message: `You have ${APP_VERSION}. Open About (user menu) to see what's new and update.`,
          dedupeKey: `update-available:${found.version}`,
        });
      }
    }
  } catch (err) {
    state.checkError = err instanceof Error ? err.message : String(err);
  } finally {
    state.checkedAt = new Date().toISOString();
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** The staged release of this version, if complete and verified. */
export function stagedManifest(version: string): Manifest | null {
  try {
    const dir = stagedDir(version);
    const m = verifyManifest(fs.readFileSync(path.join(dir, 'manifest.json')), fs.readFileSync(path.join(dir, 'manifest.json.sig')));
    if (m.version !== version || !fs.existsSync(path.join(dir, '.verified'))) return null;
    return m;
  } catch {
    return null;
  }
}

function newestStaged(): Manifest | null {
  const root = path.join(updatesDir(), 'staged');
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((v) => VERSION_RE.test(v)) : [];
  return (
    versions
      .filter((v) => compareVersions(v, APP_VERSION) > 0)
      .sort((a, b) => compareVersions(b, a))
      .map(stagedManifest)
      .find(Boolean) ?? null
  );
}

/**
 * Downloads the available release into staged/<version> (image streamed, SHA-256 checked) in the background.
 * With install, the updater is asked to install it as soon as it is verified (the one-click Update).
 */
export function startDownload(opts: { install?: boolean } = {}): void {
  const a = state.available;
  // Already here (downloaded earlier, or an uploaded bundle): nothing to fetch.
  const staged = newestStaged();
  if (staged && (!a || compareVersions(staged.version, a.version) >= 0)) {
    if (opts.install) requestInstall(staged.version);
    return;
  }
  if (!a) throw new HttpError(409, 'No update is available. Check for updates first.');
  if (opts.install && !hostInfo()) throw new HttpError(409, 'This installation has no updater; update it as described in About.');
  if (stagedManifest(a.version)) {
    if (opts.install) requestInstall(a.version);
    return;
  }
  if (state.download && !state.download.done && !state.download.error) {
    if (opts.install) state.download.install = true;
    return;
  }
  state.download = { version: a.version, received: 0, total: a.manifest.image.size, error: null, done: false, install: Boolean(opts.install) };
  const d = state.download;
  void (async () => {
    const dir = stagedDir(a.version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const [m, s] = await Promise.all([fetchChecked(a.manifestUrl), fetchChecked(a.signatureUrl)]);
    const manifestBytes = Buffer.from(await m.arrayBuffer());
    const sigBytes = Buffer.from(await s.arrayBuffer());
    const manifest = verifyManifest(manifestBytes, sigBytes);
    fs.writeFileSync(path.join(dir, 'manifest.json'), manifestBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'manifest.json.sig'), sigBytes, { mode: 0o600 });
    const res = await fetchChecked(a.imageUrl, 60 * 60_000);
    if (!res.body) throw new Error('empty download');
    const hash = crypto.createHash('sha256');
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        d.received += chunk.length;
        if (d.received > manifest.image.size) return cb(new Error('The download is larger than the release says.'));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const part = path.join(dir, `${manifest.image.file}.part`);
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, fs.createWriteStream(part, { mode: 0o600 }));
    if (hash.digest('hex') !== manifest.image.sha256) throw new Error('The downloaded image does not match the signed release (SHA-256).');
    fs.renameSync(part, path.join(dir, manifest.image.file));
    fs.writeFileSync(path.join(dir, '.verified'), new Date().toISOString());
    d.done = true;
    if (d.install) {
      // A refusal here (a job started meanwhile) keeps the verified download; Update asks again.
      try {
        requestInstall(a.version);
      } catch (err) {
        d.installError = err instanceof Error ? err.message : String(err);
      }
    }
  })().catch((err) => {
    d.error = err instanceof Error ? err.message : String(err);
    fs.rmSync(stagedDir(a.version), { recursive: true, force: true });
  });
}

/** An offline bundle (.hpupdate: a tar of manifest.json, manifest.json.sig and the image), already saved to `file`. */
export async function stageBundle(file: string): Promise<Manifest> {
  try {
    const { stdout } = await execFileP('tar', ['-tf', file], { timeout: 60_000 });
    const names = stdout.split('\n').filter(Boolean);
    const image = names.find((n) => /^holodeck-portal-\d+\.\d+\.\d+\.image\.tar\.gz$/.test(n));
    const expected = ['manifest.json', 'manifest.json.sig', image].sort();
    if (!image || names.length !== 3 || JSON.stringify([...names].sort()) !== JSON.stringify(expected)) {
      throw new HttpError(400, 'This is not a Holodeck Portal update bundle (.hpupdate).');
    }
    const tmp = fs.mkdtempSync(path.join(updatesDir(), 'bundle-'));
    try {
      await execFileP('tar', ['-xf', file, '-C', tmp, '--no-same-owner', '--no-same-permissions', 'manifest.json', 'manifest.json.sig', image], { timeout: 10 * 60_000 });
      for (const n of expected as string[]) {
        const st = fs.lstatSync(path.join(tmp, n));
        if (!st.isFile()) throw new HttpError(400, 'The bundle contains something other than plain files.');
      }
      const manifest = verifyManifest(fs.readFileSync(path.join(tmp, 'manifest.json')), fs.readFileSync(path.join(tmp, 'manifest.json.sig')));
      if (manifest.image.file !== image) throw new HttpError(400, 'The bundle\'s image does not match its manifest.');
      if (compareVersions(manifest.version, APP_VERSION) <= 0) throw new HttpError(400, `The bundle is version ${manifest.version}; this portal already runs ${APP_VERSION}.`);
      const st = fs.statSync(path.join(tmp, image));
      if (st.size !== manifest.image.size || (await sha256File(path.join(tmp, image))) !== manifest.image.sha256) {
        throw new HttpError(400, 'The bundle\'s image does not match the signed release (SHA-256).');
      }
      const dir = stagedDir(manifest.version);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(tmp, dir);
      fs.writeFileSync(path.join(dir, '.verified'), new Date().toISOString());
      return manifest;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Hands the staged release to the appliance's updater. */
export function requestInstall(version: string): void {
  if (!hostInfo()) throw new HttpError(409, 'This installation has no updater; update it as described in About.');
  const manifest = stagedManifest(version);
  if (!manifest) throw new HttpError(409, `Version ${version} is not downloaded and verified yet.`);
  if (compareVersions(version, APP_VERSION) <= 0) throw new HttpError(409, `This portal already runs ${APP_VERSION}.`);
  if (compareVersions(APP_VERSION, manifest.minFromVersion) < 0) {
    throw new HttpError(409, `Version ${version} needs at least ${manifest.minFromVersion} installed first.`);
  }
  // Jobs running inside the portal (vCenter control jobs) would stop with it; lab jobs on routers carry on and re-attach.
  const local = get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE holorouter_id IS NULL AND status IN ('queued','running','waiting_input')")?.n ?? 0;
  if (local) throw new HttpError(409, `${local} portal job${local === 1 ? ' is' : 's are'} running (vCenter tasks such as a Holorouter deployment). Update when ${local === 1 ? 'it has' : 'they have'} finished.`);
  const cur = updaterStatus();
  if (cur?.state === 'running') throw new HttpError(409, 'An update is already running.');
  const file = path.join(updatesDir(), 'request.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version, requestedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Everything the About dialog shows. */
export function updatesView() {
  const host = hostInfo();
  const staged = newestStaged();
  const available = state.available && compareVersions(state.available.version, APP_VERSION) > 0 ? state.available : null;
  const offer = staged && (!available || compareVersions(staged.version, available.version) >= 0) ? staged : available?.manifest ?? null;
  const status = updaterStatus();
  return {
    current: APP_VERSION,
    formFactor: FORM_FACTOR,
    oneClick: Boolean(host),
    source: sourceConfigured() ? describeSource() : null,
    autoCheck: getSettings().updates.autoCheck,
    checkedAt: state.checkedAt,
    checkError: state.checkError,
    available: offer
      ? {
          version: offer.version,
          notes: offer.notes,
          published: offer.published,
          size: offer.image.size,
          releaseUrl: available?.version === offer.version ? available.releaseUrl : null,
          staged: Boolean(staged && staged.version === offer.version),
          minFromVersion: offer.minFromVersion,
        }
      : null,
    download: state.download,
    // The updater's last run; "succeeded" for the version now running is what the dialog shows after the restart.
    status,
    manualSteps: host ? null : manualSteps(offer?.version ?? null),
  };
}

function describeSource(): string {
  const src = getSettings().updates.source;
  return src.type === 'gitlab' ? `GitLab ${new URL(src.url).host}/${src.project}` : `GitHub ${src.repo}`;
}

/**
 * Containers without the appliance's updater: what the administrator runs on the Docker host. The verifier and the
 * release key come out of the running (trusted) portal, not from where the release was downloaded.
 */
function manualSteps(version: string | null) {
  const v = version ?? '<version>';
  return [
    `Download holodeck-portal-${v}.hpupdate from the release page, then on the Docker host, next to docker-compose.yml:`,
    'docker cp holodeck-portal:/opt/holodeck-portal/release ./hp-release',
    `./hp-release/verify-release.sh holodeck-portal-${v}.hpupdate`,
    `HP_PORTAL_IMAGE=holodeck-portal:${v} docker compose up -d`,
  ];
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
export function startUpdateChecks() {
  if (timer) return;
  const tick = () => {
    if (getSettings().updates.autoCheck && sourceConfigured()) void checkForUpdates();
  };
  timer = setInterval(tick, 24 * 3600_000);
  timer.unref();
  setTimeout(tick, 2 * 60_000).unref();
}
