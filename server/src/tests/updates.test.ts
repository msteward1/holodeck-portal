/** Portal updates: signed manifests, offline bundles, install requests for the appliance's updater. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-upd-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_ETC_DIR = path.join(tmp, 'etc');
process.env.HP_RELEASE_KEYS_DIR = path.join(tmp, 'keys');
process.env.HP_VERSION = '0.4.0';
process.env.HP_LOG_LEVEL = 'silent';
fs.mkdirSync(process.env.HP_RELEASE_KEYS_DIR, { recursive: true });

// A release key (shipped and trusted) and a development key (shipped; trusted only where the host says so).
const release = crypto.generateKeyPairSync('ed25519');
const dev = crypto.generateKeyPairSync('ed25519');
const rogue = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(path.join(process.env.HP_RELEASE_KEYS_DIR, 'release-signing.pub'), release.publicKey.export({ type: 'spki', format: 'pem' }));
fs.writeFileSync(path.join(process.env.HP_RELEASE_KEYS_DIR, 'dev-signing.pub'), dev.publicKey.export({ type: 'spki', format: 'pem' }));

const { run } = await import('../db.js');
const u = await import('../updates.js');

const image = Buffer.from('not really an image, but bytes with a digest');
function release_(version: string, key = release.privateKey, pub = release.publicKey, extra: Record<string, unknown> = {}) {
  const file = `holodeck-portal-${version}.image.tar.gz`;
  const manifest = Buffer.from(
    JSON.stringify({
      product: 'holodeck-portal',
      version,
      published: new Date().toISOString(),
      minFromVersion: '0.4.0',
      image: { file, sha256: crypto.createHash('sha256').update(image).digest('hex'), size: image.length, id: `sha256:${'a'.repeat(64)}`, tag: `holodeck-portal:${version}` },
      notes: 'Fixes',
      ...extra,
    }),
  );
  const sig = Buffer.from(JSON.stringify({ keyId: u.keyId(pub), signature: crypto.sign(null, manifest, key).toString('base64') }));
  return { manifest, sig, file };
}
function bundle(version: string, r = release_(version), extraFile?: string) {
  const d = fs.mkdtempSync(path.join(tmp, 'b-'));
  fs.writeFileSync(path.join(d, 'manifest.json'), r.manifest);
  fs.writeFileSync(path.join(d, 'manifest.json.sig'), r.sig);
  fs.writeFileSync(path.join(d, r.file), image);
  const names = ['manifest.json', 'manifest.json.sig', r.file];
  if (extraFile) {
    fs.writeFileSync(path.join(d, extraFile), 'x');
    names.push(extraFile);
  }
  const out = path.join(tmp, `${version}-${crypto.randomBytes(3).toString('hex')}.hpupdate`);
  execFileSync('tar', ['-C', d, '-cf', out, ...names]);
  fs.mkdirSync(u.updatesDir(), { recursive: true });
  const upload = path.join(u.updatesDir(), path.basename(out));
  fs.copyFileSync(out, upload);
  return upload;
}
const hostTrusts = (...ids: string[]) =>
  fs.writeFileSync(path.join(u.updatesDir(), 'host.json'), JSON.stringify({ updaterVersion: '1', trustedKeyIds: ids, currentVersion: '0.4.0' }));

test('versions compare numerically', () => {
  assert.ok(u.compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(u.compareVersions('1.2.3', '1.2.3'), 0);
});

test('signatures: release key accepted, changed manifests and unknown keys refused, dev key only when the host trusts it', () => {
  const r = release_('0.4.1');
  assert.equal(u.verifyManifest(r.manifest, r.sig).version, '0.4.1');
  const tampered = Buffer.from(r.manifest.toString().replace('Fixes', 'Fixes!'));
  assert.throws(() => u.verifyManifest(tampered, r.sig), /not valid/);
  const bad = release_('0.4.1', rogue.privateKey, rogue.publicKey);
  assert.throws(() => u.verifyManifest(bad.manifest, bad.sig), /does not trust/);
  const d = release_('0.4.1', dev.privateKey, dev.publicKey);
  // No updater (container install): only the release key.
  assert.throws(() => u.verifyManifest(d.manifest, d.sig), /does not trust/);
  fs.mkdirSync(u.updatesDir(), { recursive: true });
  hostTrusts(u.keyId(release.publicKey), u.keyId(dev.publicKey));
  assert.equal(u.verifyManifest(d.manifest, d.sig).version, '0.4.1');
  hostTrusts(u.keyId(release.publicKey));
  assert.throws(() => u.verifyManifest(d.manifest, d.sig), /does not trust/);
});

test('offline bundles: verified and staged; extra files, old versions and wrong digests refused', async () => {
  const m = await u.stageBundle(bundle('0.4.2'));
  assert.equal(m.version, '0.4.2');
  assert.ok(u.stagedManifest('0.4.2'));
  await assert.rejects(u.stageBundle(bundle('0.4.3', undefined, 'evil.sh')), /not a Holodeck Portal update bundle/);
  await assert.rejects(u.stageBundle(bundle('0.3.9')), /already runs 0\.4\.0/);
  const wrong = release_('0.4.4', release.privateKey, release.publicKey, { image: { file: 'holodeck-portal-0.4.4.image.tar.gz', sha256: 'b'.repeat(64), size: image.length, id: `sha256:${'a'.repeat(64)}`, tag: 'holodeck-portal:0.4.4' } });
  await assert.rejects(u.stageBundle(bundle('0.4.4', wrong)), /does not match the signed release/);
  // Uploaded files are always deleted.
  assert.deepEqual(fs.readdirSync(u.updatesDir()).filter((f) => f.endsWith('.hpupdate')), []);
});

test('install requests go to the updater only for verified, newer releases and with no portal job running', () => {
  assert.throws(() => u.requestInstall('0.4.9'), /not downloaded/);
  run("INSERT INTO jobs (id, type, status) VALUES ('j1', 'router-deploy', 'running')");
  assert.throws(() => u.requestInstall('0.4.2'), /portal job is running/);
  run("UPDATE jobs SET status = 'succeeded'");
  u.requestInstall('0.4.2');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(u.updatesDir(), 'request.json'), 'utf8')).version, '0.4.2');
  fs.rmSync(path.join(u.updatesDir(), 'host.json'));
  assert.throws(() => u.requestInstall('0.4.2'), /no updater/);
  const view = u.updatesView();
  assert.equal(view.oneClick, false);
  assert.equal(view.available?.version, '0.4.2');
  assert.ok(view.manualSteps?.some((s) => s.includes('verify-release.sh')));
  assert.ok(!view.manualSteps?.some((s) => s.includes('docker load')), 'never an unverified load');
});
