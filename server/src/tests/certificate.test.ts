/** Settings → Certificate: CSR, CA-signed install with chain, checks, PEM/PFX upload, self-signed, rollback. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-cert-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_ETC_DIR = path.join(tmp, 'etc');
process.env.HP_PUBLIC_URL = 'https://portal.test.lab';
process.env.HP_NGINX_RELOAD = '0';
process.env.HP_LOG_LEVEL = 'silent';

const cert = await import('../certificate.js');
const ca = path.join(tmp, 'ca');
fs.mkdirSync(ca);
const ossl = (...args: string[]) => execFileSync('openssl', args, { cwd: ca, stdio: ['pipe', 'pipe', 'pipe'] }).toString();

// A root and an intermediate CA.
ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.crt', '-days', '30', '-subj', '/CN=Test Root',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
ossl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'int.key', '-out', 'int.csr', '-subj', '/CN=Test Intermediate');
fs.writeFileSync(path.join(ca, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
ossl('x509', '-req', '-in', 'int.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'int.crt', '-days', '20', '-extfile', 'ca.ext');
const signCsr = (csr: string, name: string) => {
  fs.writeFileSync(path.join(ca, `${name}.csr`), csr);
  fs.writeFileSync(path.join(ca, 'leaf.ext'), 'subjectAltName=DNS:portal.test.lab,DNS:holodeck.test.lab\n');
  ossl('x509', '-req', '-in', `${name}.csr`, '-CA', 'int.crt', '-CAkey', 'int.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '10', '-extfile', 'leaf.ext');
  return fs.readFileSync(path.join(ca, `${name}.crt`), 'utf8');
};
const read = (f: string) => fs.readFileSync(path.join(ca, f), 'utf8');
const crtFile = () => fs.readFileSync(path.join(process.env.HP_ETC_DIR!, 'ssl', 'portal.crt'), 'utf8');

test('self-signed to start with; it names the portal', async () => {
  const c = await cert.regenerateSelfSigned(['holodeck.test.lab']);
  assert.equal(c.selfSigned, true);
  assert.deepEqual(c.names, ['portal.test.lab', 'holodeck.test.lab']);
  assert.equal(c.coversPortal, true);
  assert.equal(fs.statSync(path.join(process.env.HP_ETC_DIR!, 'ssl', 'portal.key')).mode & 0o777, 0o600);
});

test('CSR on the portal, signed certificate installed with its chain (any order), key never sent', async () => {
  const csr = await cert.generateCsr({ commonName: 'portal.test.lab', altNames: ['holodeck.test.lab'], organization: 'Lab / Test', country: 'US', keyType: 'rsa-2048' });
  assert.match(csr, /BEGIN CERTIFICATE REQUEST/);
  fs.writeFileSync(path.join(ca, 'check.csr'), csr);
  const text = ossl('req', '-in', 'check.csr', '-noout', '-text');
  assert.match(text, /DNS:portal\.test\.lab, DNS:holodeck\.test\.lab/);
  assert.match(text, /O\s*=\s*Lab \/ Test/);
  const status = cert.certificateStatus();
  assert.ok(status.pending);
  assert.equal(JSON.stringify(status).includes('PRIVATE KEY'), false);
  const leaf = signCsr(csr, 'leaf1');
  // Root first, leaf last: the portal reorders and leaves the root out.
  const c = await cert.installSigned(read('root.crt') + read('int.crt') + leaf);
  assert.equal(c.issuer, 'Test Intermediate');
  assert.equal(c.selfSigned, false);
  const served = crtFile().match(/BEGIN CERTIFICATE/g)!.length;
  assert.equal(served, 2, 'leaf + intermediate');
  assert.equal(cert.certificateStatus().pending, null);
  assert.equal(cert.certificateStatus().previous?.leaf.selfSigned, true);
});

test('checks: a certificate for another key, another name, or unrelated chain members is refused', async () => {
  // No pending CSR any more.
  await assert.rejects(cert.installSigned(read('int.crt')), /no pending certificate request/);
  const csr = await cert.generateCsr({ commonName: 'portal.test.lab', altNames: [], keyType: 'ecdsa-p256' });
  void csr;
  // The leaf signed for the previous CSR does not match the new key.
  await assert.rejects(cert.installSigned(read('leaf1.crt')), /matches the private key/);
  // Wrong name.
  ossl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'other.key', '-out', 'other.csr', '-subj', '/CN=other.lab');
  fs.writeFileSync(path.join(ca, 'other.ext'), 'subjectAltName=DNS:other.lab\n');
  ossl('x509', '-req', '-in', 'other.csr', '-CA', 'int.crt', '-CAkey', 'int.key', '-CAcreateserial', '-out', 'other.crt', '-days', '5', '-extfile', 'other.ext');
  await assert.rejects(cert.installUploaded({ certificate: read('other.crt'), privateKey: read('other.key') }), /does not name portal\.test\.lab/);
  // Unrelated extra certificate.
  ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'x.key', '-out', 'x.crt', '-days', '5', '-subj', '/CN=Unrelated');
  await assert.rejects(
    cert.installUploaded({ certificate: read('other.crt') + read('x.crt'), privateKey: read('other.key'), allowOtherName: true }),
    /not part of this certificate's chain/,
  );
  cert.discardCsr();
  assert.equal(cert.certificateStatus().pending, null);
});

test('PFX upload with password, then rollback swaps back (and can be undone)', async () => {
  const leaf = signCsr(ossl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'pfx.key', '-subj', '/CN=portal.test.lab'), 'pfx');
  ossl('pkcs12', '-export', '-in', 'pfx.crt', '-inkey', 'pfx.key', '-certfile', 'int.crt', '-out', 'p.pfx', '-passout', 'pass:s3cret');
  const pfxBase64 = fs.readFileSync(path.join(ca, 'p.pfx')).toString('base64');
  await assert.rejects(cert.installUploaded({ pfxBase64, passphrase: 'wrong' }), /could not be opened/);
  const before = cert.certificateStatus().current!.leaf.sha256;
  const c = await cert.installUploaded({ pfxBase64, passphrase: 's3cret' });
  assert.equal(c.issuer, 'Test Intermediate');
  assert.notEqual(c.sha256, before);
  assert.ok(leaf.includes('BEGIN CERTIFICATE'));
  const back = await cert.rollback();
  assert.equal(back.sha256, before);
  const again = await cert.rollback();
  assert.equal(again.sha256, c.sha256);
});

test('expiry warnings at 30 and 7 days, once per certificate', () => {
  const sent: string[] = [];
  cert.checkCertificateExpiry((n) => sent.push(n.dedupeKey));
  // The installed test certificate is valid for 10 days: inside the 30-day window.
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^cert-expiry-30:/);
});
