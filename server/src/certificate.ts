/**
 * The portal's TLS certificate (nginx serves it on 443 and the webtop gateway ports), managed from Settings:
 * generate a key and CSR on the portal (the key never leaves it), install the CA-signed certificate, upload a
 * certificate with its key (PEM or PFX), regenerate a self-signed one, and roll back to the previous certificate.
 * Every change is checked (key match, validity, the portal's name, chain order) and nginx is tested before it
 * reloads; a failed test restores the previous files.
 */
import crypto, { X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config, FORM_FACTOR } from './config.js';
import { HttpError } from './labs.js';

const execFileP = promisify(execFile);

const dir = () => path.join(config.etcDir, 'ssl');
const file = (name: string) => path.join(dir(), name);
const CRT = 'portal.crt';
const KEY = 'portal.key';
const PREV_CRT = 'portal.previous.crt';
const PREV_KEY = 'portal.previous.key';
const PENDING_KEY = 'portal.pending.key';
const PENDING_CSR = 'portal.csr';
const PENDING_META = 'portal.csr.json';

export function portalHostname(): string {
  return new URL(config.publicUrl).hostname;
}

// ---------------------------------------------------------------------------
// Reading certificates
// ---------------------------------------------------------------------------

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Every certificate in a PEM bundle, in order. */
export function splitPem(pem: string): X509Certificate[] {
  const blocks = pem.match(PEM_CERT) ?? [];
  return blocks.map((b) => {
    try {
      return new X509Certificate(b);
    } catch {
      throw new HttpError(400, 'A certificate in the file could not be read (expected PEM).');
    }
  });
}

function altNames(c: X509Certificate): string[] {
  return (c.subjectAltName ?? '')
    .split(/,\s*/)
    .filter(Boolean)
    .map((n) => n.replace(/^DNS:/, '').replace(/^IP Address:/, ''));
}

function field(dn: string, key: string): string | null {
  const line = dn.split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : null;
}

export function describeCert(c: X509Certificate) {
  const notAfter = new Date(c.validTo);
  return {
    subject: field(c.subject, 'CN') ?? c.subject.replace(/\n/g, ', '),
    subjectDn: c.subject.replace(/\n/g, ', '),
    names: altNames(c),
    issuer: field(c.issuer, 'CN') ?? c.issuer.replace(/\n/g, ', '),
    issuerDn: c.issuer.replace(/\n/g, ', '),
    selfSigned: c.subject === c.issuer && c.checkIssued(c),
    notBefore: new Date(c.validFrom).toISOString(),
    notAfter: notAfter.toISOString(),
    daysLeft: Math.floor((notAfter.getTime() - Date.now()) / 86400_000),
    sha256: c.fingerprint256,
    serial: c.serialNumber,
    keyType: c.publicKey.asymmetricKeyType === 'rsa' ? `RSA ${c.publicKey.asymmetricKeyDetails?.modulusLength ?? ''}`.trim() : `EC ${c.publicKey.asymmetricKeyDetails?.namedCurve ?? ''}`.trim(),
    coversPortal: Boolean(c.checkHost(portalHostname())),
  };
}

function readCertFile(name: string) {
  try {
    const certs = splitPem(fs.readFileSync(file(name), 'utf8'));
    return certs.length ? { leaf: describeCert(certs[0]), chain: certs.slice(1).map(describeCert) } : null;
  } catch {
    return null;
  }
}

export function certificateStatus() {
  let pending = null;
  if (fs.existsSync(file(PENDING_CSR)) && fs.existsSync(file(PENDING_KEY))) {
    const meta = JSON.parse(fs.readFileSync(file(PENDING_META), 'utf8') || '{}');
    pending = { ...meta, csr: fs.readFileSync(file(PENDING_CSR), 'utf8') };
  }
  return {
    hostname: portalHostname(),
    current: readCertFile(CRT),
    previous: fs.existsSync(file(PREV_KEY)) ? readCertFile(PREV_CRT) : null,
    pending,
    // nginx can be reloaded by the portal (appliance and container); a host install may need it reloaded by hand.
    formFactor: FORM_FACTOR,
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Leaf first, then intermediates each issued by the next, key matches, valid now, names the portal.
 * Returns the PEM nginx should serve (leaf + chain, without a self-signed root).
 */
export function validateCertificate(certPem: string, key: crypto.KeyObject, opts: { allowOtherName?: boolean } = {}): { pem: string; leaf: X509Certificate } {
  let certs = splitPem(certPem);
  if (!certs.length) throw new HttpError(400, 'No certificate found. Paste or upload the PEM certificate (-----BEGIN CERTIFICATE-----).');
  // Put the certificate that matches the key first (some CAs send the chain root-first).
  const leafIndex = certs.findIndex((c) => c.checkPrivateKey(key));
  if (leafIndex === -1) {
    throw new HttpError(400, 'None of the certificates matches the private key. Was the CSR generated again after this certificate was requested?');
  }
  const leaf = certs[leafIndex];
  const rest = certs.filter((_, i) => i !== leafIndex);
  // Order the chain: each certificate issued by the next.
  const chain: X509Certificate[] = [];
  let cur = leaf;
  while (rest.length) {
    const i = rest.findIndex((c) => cur.checkIssued(c) && cur.verify(c.publicKey));
    if (i === -1) break;
    cur = rest.splice(i, 1)[0];
    chain.push(cur);
  }
  if (rest.length) throw new HttpError(400, `${rest.length} certificate(s) in the file are not part of this certificate's chain.`);
  const now = Date.now();
  if (Date.parse(leaf.validFrom) > now) throw new HttpError(400, `The certificate is not valid yet (from ${new Date(leaf.validFrom).toUTCString()}).`);
  if (Date.parse(leaf.validTo) <= now) throw new HttpError(400, `The certificate expired on ${new Date(leaf.validTo).toUTCString()}.`);
  for (const c of chain) {
    if (Date.parse(c.validTo) <= now) throw new HttpError(400, `The chain certificate ${field(c.subject, 'CN') ?? c.subject} has expired.`);
  }
  if (!opts.allowOtherName && !leaf.checkHost(portalHostname())) {
    throw new HttpError(400, `The certificate does not name ${portalHostname()} (it names ${altNames(leaf).join(', ') || field(leaf.subject, 'CN')}). Browsers would warn on every visit.`);
  }
  // A self-signed root at the end adds nothing for browsers; leave it out.
  const served = [leaf, ...chain.filter((c, i) => !(i === chain.length - 1 && c.subject === c.issuer && c.checkIssued(c)))];
  return { pem: served.map((c) => c.toString().trim()).join('\n') + '\n', leaf };
}

function readKey(pem: string, passphrase?: string): crypto.KeyObject {
  try {
    return crypto.createPrivateKey({ key: pem, format: 'pem', ...(passphrase ? { passphrase } : {}) });
  } catch {
    throw new HttpError(400, passphrase ? 'The private key could not be read (wrong passphrase?).' : 'The private key could not be read. If it is encrypted, give its passphrase.');
  }
}

/** nginx needs the key unencrypted; PKCS#8 PEM. */
const keyPem = (k: crypto.KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }).toString();

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

async function nginx(args: string[]) {
  if (process.env.HP_NGINX_RELOAD === '0') return;
  await execFileP('nginx', args, { timeout: 30_000 });
}

/** Writes the new pair, keeps the current one as "previous", tests nginx and reloads; restores on failure. */
async function install(certPem: string, key: crypto.KeyObject) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const had = fs.existsSync(file(CRT)) && fs.existsSync(file(KEY));
  const backup = had ? { crt: fs.readFileSync(file(CRT)), key: fs.readFileSync(file(KEY)) } : null;
  const writeAtomic = (name: string, data: string | Buffer, mode: number) => {
    const tmp = file(`.${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file(name));
  };
  writeAtomic(KEY, keyPem(key), 0o600);
  writeAtomic(CRT, certPem, 0o644);
  try {
    await nginx(['-t', '-q']);
  } catch (err) {
    if (backup) {
      writeAtomic(KEY, backup.key, 0o600);
      writeAtomic(CRT, backup.crt, 0o644);
    }
    throw new HttpError(400, `nginx rejected the certificate, so the previous one was kept: ${(err as { stderr?: string }).stderr?.trim() || (err as Error).message}`);
  }
  if (backup) {
    writeAtomic(PREV_KEY, backup.key, 0o600);
    writeAtomic(PREV_CRT, backup.crt, 0o644);
  }
  await reloadNginx();
}

export async function reloadNginx() {
  if (process.env.HP_NGINX_RELOAD === '0') return;
  if (FORM_FACTOR === 'host') await execFileP('systemctl', ['reload', 'nginx'], { timeout: 30_000 });
  else await nginx(['-s', 'reload']);
}

function clearPending() {
  for (const f of [PENDING_KEY, PENDING_CSR, PENDING_META]) fs.rmSync(file(f), { force: true });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface CsrRequest {
  commonName: string;
  altNames: string[];
  organization?: string;
  organizationalUnit?: string;
  locality?: string;
  state?: string;
  country?: string;
  keyType: 'rsa-2048' | 'rsa-3072' | 'rsa-4096' | 'ecdsa-p256' | 'ecdsa-p384';
}

/** Subject values go to openssl as one -subj argument: escape its separators. */
const subj = (v: string) => v.replace(/[\\/=+]/g, (m) => `\\${m}`);

function sanList(names: string[]) {
  return names.map((n) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(n) || n.includes(':') ? `IP:${n}` : `DNS:${n}`)).join(',');
}

/** A new key and CSR on the portal; the current certificate stays in use until the signed one is installed. */
export async function generateCsr(req: CsrRequest) {
  const names = [...new Set([req.commonName, ...req.altNames].map((n) => n.trim().toLowerCase()).filter(Boolean))];
  const key =
    req.keyType.startsWith('rsa')
      ? crypto.generateKeyPairSync('rsa', { modulusLength: Number(req.keyType.slice(4)) }).privateKey
      : crypto.generateKeyPairSync('ec', { namedCurve: req.keyType === 'ecdsa-p256' ? 'prime256v1' : 'secp384r1' }).privateKey;
  const parts: [string, string | undefined][] = [
    ['C', req.country],
    ['ST', req.state],
    ['L', req.locality],
    ['O', req.organization],
    ['OU', req.organizationalUnit],
    ['CN', req.commonName],
  ];
  const subject = parts.filter(([, v]) => v?.trim()).map(([k, v]) => `/${k}=${subj(v!.trim())}`).join('');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-csr-'));
  try {
    const keyFile = path.join(work, 'key.pem');
    fs.writeFileSync(keyFile, keyPem(key), { mode: 0o600 });
    const { stdout } = await execFileP('openssl', ['req', '-new', '-key', keyFile, '-subj', subject, '-addext', `subjectAltName=${sanList(names)}`, '-sha256'], {
      timeout: 30_000,
    });
    if (!stdout.includes('BEGIN CERTIFICATE REQUEST')) throw new Error('openssl produced no CSR');
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file(PENDING_KEY), keyPem(key), { mode: 0o600 });
    fs.writeFileSync(file(PENDING_CSR), stdout, { mode: 0o644 });
    fs.writeFileSync(file(PENDING_META), JSON.stringify({ subject, names, keyType: req.keyType, createdAt: new Date().toISOString() }), { mode: 0o600 });
    return stdout;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function discardCsr() {
  clearPending();
}

/** The CA-signed certificate for the pending CSR (with its chain). */
export async function installSigned(certPem: string, opts: { allowOtherName?: boolean } = {}) {
  if (!fs.existsSync(file(PENDING_KEY))) throw new HttpError(409, 'There is no pending certificate request. Generate a CSR first, or upload the certificate with its key.');
  const key = readKey(fs.readFileSync(file(PENDING_KEY), 'utf8'));
  const { pem, leaf } = validateCertificate(certPem, key, opts);
  await install(pem, key);
  clearPending();
  return describeCert(leaf);
}

/** A certificate and key issued elsewhere: PEM (key optionally encrypted) or a PFX/PKCS#12 file. */
export async function installUploaded(input: { certificate?: string; privateKey?: string; pfxBase64?: string; passphrase?: string; allowOtherName?: boolean }) {
  let certPem = input.certificate ?? '';
  let keyText = input.privateKey ?? '';
  if (input.pfxBase64) {
    ({ certPem, keyText } = await readPfx(Buffer.from(input.pfxBase64, 'base64'), input.passphrase ?? ''));
  }
  if (!keyText.trim()) throw new HttpError(400, 'The private key is missing.');
  const key = readKey(keyText, input.pfxBase64 ? undefined : input.passphrase || undefined);
  const { pem, leaf } = validateCertificate(certPem, key, { allowOtherName: input.allowOtherName });
  await install(pem, key);
  return describeCert(leaf);
}

async function readPfx(pfx: Buffer, passphrase: string) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-pfx-'));
  const pfxFile = path.join(work, 'in.pfx');
  fs.writeFileSync(pfxFile, pfx, { mode: 0o600 });
  const env = { ...process.env, HP_PFX_PASS: passphrase };
  const run = async (extra: string[]) => {
    for (const legacy of [[], ['-legacy']]) {
      try {
        return (await execFileP('openssl', ['pkcs12', '-in', pfxFile, '-passin', 'env:HP_PFX_PASS', ...extra, ...legacy], { env, timeout: 30_000 })).stdout;
      } catch (err) {
        if (legacy.length) throw err;
      }
    }
    return '';
  };
  try {
    const certPem = await run(['-nokeys']);
    const keyText = await run(['-nocerts', '-nodes']);
    return { certPem, keyText: (keyText.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/) ?? [''])[0] };
  } catch {
    throw new HttpError(400, 'The PFX file could not be opened (wrong password, or not a PKCS#12 file).');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** A new self-signed certificate for the portal's name (and any extra names), valid 825 days. */
export async function regenerateSelfSigned(extraNames: string[] = []) {
  const names = [...new Set([portalHostname(), ...extraNames].map((n) => n.trim().toLowerCase()).filter(Boolean))];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-self-'));
  try {
    const keyFile = path.join(work, 'key.pem');
    const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    fs.writeFileSync(keyFile, keyPem(key), { mode: 0o600 });
    const { stdout } = await execFileP(
      'openssl',
      ['req', '-x509', '-new', '-key', keyFile, '-days', '825', '-sha256', '-subj', `/CN=${subj(portalHostname())}`, '-addext', `subjectAltName=${sanList(names)}`],
      { timeout: 30_000 },
    );
    const { pem, leaf } = validateCertificate(stdout, key);
    await install(pem, key);
    return describeCert(leaf);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Back to the previous certificate; the current one becomes "previous", so a rollback can be undone. */
export async function rollback() {
  if (!fs.existsSync(file(PREV_CRT)) || !fs.existsSync(file(PREV_KEY))) throw new HttpError(409, 'There is no previous certificate.');
  const prevCrt = fs.readFileSync(file(PREV_CRT), 'utf8');
  const key = readKey(fs.readFileSync(file(PREV_KEY), 'utf8'));
  const leaf = splitPem(prevCrt)[0];
  if (!leaf || !leaf.checkPrivateKey(key)) throw new HttpError(409, 'The previous certificate and key do not match.');
  await install(prevCrt, key);
  return describeCert(leaf);
}

// ---------------------------------------------------------------------------
// Expiry warnings
// ---------------------------------------------------------------------------

/** Administrators are told 30 and 7 days before the certificate expires (once each per certificate). */
export function checkCertificateExpiry(notifyAdmins: (opts: { level: 'warning' | 'error'; title: string; message: string; dedupeKey: string }) => void) {
  const cur = readCertFile(CRT)?.leaf;
  if (!cur) return;
  const threshold = cur.daysLeft <= 0 ? 0 : cur.daysLeft <= 7 ? 7 : cur.daysLeft <= 30 ? 30 : null;
  if (threshold === null) return;
  notifyAdmins({
    level: threshold <= 7 ? 'error' : 'warning',
    title: cur.daysLeft <= 0 ? 'The portal certificate has expired' : `The portal certificate expires in ${cur.daysLeft} day${cur.daysLeft === 1 ? '' : 's'}`,
    message: `${cur.subject}, issued by ${cur.issuer}, ${cur.daysLeft <= 0 ? 'expired' : 'expires'} ${new Date(cur.notAfter).toUTCString()}. Replace it in Settings → Certificate.`,
    dedupeKey: `cert-expiry-${threshold}:${cur.sha256}`,
  });
}
