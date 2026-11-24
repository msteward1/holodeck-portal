import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The portal treats its host's eth0 subnet as a management network that lab slots must not overlap. Pin it to a
// documentation range so these tests don't depend on the machine they run on (CI runners use 10.x networks).
mock.method(os, 'networkInterfaces', () => ({
  eth0: [{ address: '198.51.100.10', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: process.env.HP_TEST_ETH0 ?? '198.51.100.10/24' }],
}));

// Isolated data dir, a fake Holodeck root with one config, and fake runners that never touch Holodeck.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-routers-'));
const psDir = path.join(tmp, 'ps');
const holoRoot = path.join(tmp, 'holodeck-runtime');
fs.mkdirSync(psDir);
fs.mkdirSync(path.join(holoRoot, 'config'), { recursive: true });
for (const site of ['a', 'b']) {
  fs.writeFileSync(path.join(holoRoot, 'config', `test-site-${site}.json`), JSON.stringify({ InstanceId: null, holorouterStatus: 'Configured', Target: { hostname: 'vc.example' } }));
}
// Holodeck's bill of materials, and the 9.1 files staged on the "primary".
fs.mkdirSync(path.join(holoRoot, 'templates'));
fs.writeFileSync(path.join(holoRoot, 'templates', 'bom.json'), JSON.stringify({
  '5.2.4': { esx: ['esx-8.iso'], 'cloud-builder': ['cb-5.2.4.ova'] },
  '9.0.2.0': { esx: ['esx-9.0.2.iso'], 'vcf-installer': ['inst-9.0.2.ova'] },
  '9.1.0.0': { esx: ['esx-9.1.iso'], 'vcf-installer': ['inst-9.1.ova'] },
}));
fs.mkdirSync(path.join(holoRoot, 'bin', '9.1.0.0'), { recursive: true });
fs.mkdirSync(path.join(holoRoot, 'bin', '9.0.2.0'), { recursive: true });
fs.writeFileSync(path.join(holoRoot, 'bin', '9.1.0.0', 'esx-9.1.iso'), 'x');
fs.writeFileSync(path.join(holoRoot, 'bin', '9.1.0.0', 'inst-9.1.ova'), 'x');
// A patch build Holodeck's precheck doesn't accept under this name.
fs.writeFileSync(path.join(holoRoot, 'bin', '9.0.2.0', 'esx-9.0.2.0100.iso'), 'x');
// Jobs stay "running" (the runner never writes an exit code) so their files can be inspected.
for (const f of ['run-job.sh', 'run-remote-job.sh']) fs.writeFileSync(path.join(psDir, f), '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_PS_DIR = psDir;
process.env.HP_HOLODECK_ROOT = holoRoot;
process.env.HP_SYSTEMD_RUN = '0';

const { run, get } = await import('../db.js');
const { deployLab, deployPreflight, effectiveCapacity, getConfig, getLab } = await import('../labs.js');
const { eligibleRouters, evaluate, getRouter, pickRouter } = await import('../holorouters.js');
const { updateSettings, getSettings } = await import('../settings.js');
const { evaluateStaging, parseBom, parseListing } = await import('../staging.js');
const { adoptLocalConfigFiles } = await import('../holodeck/configstore.js');
const { stagingSource, fleetStaging } = await import('../holorouters.js');
const { stopJobLoop } = await import('../holodeck/jobs.js');

run("INSERT INTO users (id, username, role, first_name, last_name) VALUES (1, 'admin', 'admin', 'A', 'D'), (2, 'u', 'user', 'U', 'S')");
run("INSERT INTO configs (id, config_id, name, entitle_all) VALUES (1, 'test', 'Test', 1)");
run(
  `INSERT INTO capacity_profiles (id, name, config_id, datacenter, cluster, datastore, mgmt_network, trunk_a, trunk_b)
   VALUES (1, 'P', 1, 'DC', 'Cluster2', 'DS2', 'Mgmt', 'TrunkA2', 'TrunkB2')`,
);
// The portal's copy of the Holodeck configuration (an upgraded install adopts the files it ran next to).
adoptLocalConfigFiles(path.join(holoRoot, 'config'));
// What the routers report: router 1 (the former primary, no capacity profile) holds the files laid out above.
const bomText = fs.readFileSync(path.join(holoRoot, 'templates', 'bom.json'), 'utf8');
const listing = (dir: string) => {
  const out: string[] = [];
  for (const v of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, v))) out.push(`${v}/${f}\t${fs.statSync(path.join(dir, v, f)).size}`);
  return out.join('\n');
};
const staging1 = evaluateStaging(parseBom(bomText), parseListing(listing(path.join(holoRoot, 'bin')), Object.keys(parseBom(bomText))));
run(
  `INSERT INTO holorouters (id, name, address, mgmt_ip, slot, origin, status, inspection, staging)
   VALUES (1, 'hr1', '192.0.2.1', '192.0.2.1', 1, 'imported', 'ready', '{}', ?)`,
  JSON.stringify(staging1),
);
// A healthy router in slot 2 with VCF 9.1 staged.
const staged91 = JSON.stringify({ checkedAt: 'now', versions: [{ version: '9.1.0.0', status: 'ready', esx: { name: 'esx-9.1.iso', size: 1 }, installer: { name: 'inst-9.1.ova', size: 1 } }] });
run(
  `INSERT INTO holorouters (id, name, address, mgmt_ip, slot, origin, profile_id, status, inspection, staging)
   VALUES (2, 'hr2', '192.0.2.2', '192.0.2.2', 2, 'deployed', 1, 'ready', '{}', ?)`,
  staged91,
);
updateSettings('capacity', { ...getSettings().capacity, maxActiveLabs: 5, defaultUserQuota: 5 });

const user = () => get<import('../labs.js').UserRow>('SELECT * FROM users WHERE id = 2')!;
/** Fake credentials, built at runtime (never a literal that looks like a real secret). */
const FAKE_PW = ['pw', 'test', 'only'].join('-');
const admin = () => get<import('../labs.js').UserRow>('SELECT * FROM users WHERE id = 1')!;
const jobFile = (labId: number) => {
  const job = get<{ id: string; holorouter_id: number }>("SELECT id, holorouter_id FROM jobs WHERE lab_id = ? AND type = 'lab-deploy'", labId)!;
  return { routerId: job.holorouter_id, spec: JSON.parse(fs.readFileSync(path.join(process.env.HP_DATA_DIR!, 'jobs', job.id, 'job.json'), 'utf8')) };
};

test('capacity is one lab per healthy Holorouter, capped by the setting', () => {
  assert.equal(effectiveCapacity(), 2);
  updateSettings('capacity', { ...getSettings().capacity, maxActiveLabs: 1 });
  assert.equal(effectiveCapacity(), 1);
  updateSettings('capacity', { ...getSettings().capacity, maxActiveLabs: 5 });
});

test('every router is eligible alike (there is no primary)', () => {
  assert.deepEqual(eligibleRouters(user()).map((r) => r.id), [1, 2]);
  assert.deepEqual(eligibleRouters(admin()).map((r) => r.id), [1, 2]);
});

test('the first lab gets slot 1, a per-lab DNS domain and the portal\'s config copy', () => {
  // VCF 9.0.2.0 is incomplete everywhere, so it can't be placed.
  assert.match(deployPreflight(user(), getConfig(1), { mode: 'VVF', version: '9.0.2.0' } as never).join(' '), /not available on any free Holorouter/);
  assert.match(deployPreflight(admin(), getConfig(1), { mode: 'VVF', version: '9.0.2.0' } as never).join(' '), /No Holorouter has the VCF 9\.0\.2\.0 installation files/);
  const lab = deployLab(user(), { configId: 1, name: 'one', instanceId: 'A1', options: { mode: 'VVF', version: '9.1.0.0', DNSDomain: 'evil.example' } });
  assert.equal(lab.slot, 1);
  assert.equal(lab.holorouter_id, 1);
  const { routerId, spec } = jobFile(lab.id);
  assert.equal(routerId, 1);
  const deploy = spec.steps.find((s: { command: string }) => s.command === 'New-HoloDeckInstance');
  // Users can't override the domain; it comes from the template.
  assert.equal(deploy.params.DNSDomain, 'lab01.vcf.lab');
  // Every router gets the portal's copy of the configuration first.
  assert.equal(spec.steps[0].command, 'HP-SyncConfig');
});

test('the next lab goes to the secondary, with its profile placement and a config copy', () => {
  const lab = deployLab(user(), { configId: 1, name: 'two', instanceId: 'b2', options: { mode: 'VVF', version: '9.1.0.0' } });
  assert.equal(lab.slot, 2);
  assert.equal(lab.holorouter_id, 2);
  const { routerId, spec } = jobFile(lab.id);
  assert.equal(routerId, 2);
  assert.equal(spec.steps[0].command, 'HP-SyncConfig');
  assert.deepEqual(spec.steps[0].redact, ['Files']);
  assert.ok(spec.steps[0].params.Files.a && spec.steps[0].params.Files.b);
  assert.equal(spec.env.cluster_name, 'Cluster2');
  assert.equal(spec.env.datastore_name, 'DS2');
  assert.equal(spec.env.trunk_port_group_name, 'TrunkA2');
  const deploy = spec.steps.find((s: { command: string }) => s.command === 'New-HoloDeckInstance');
  assert.deepEqual([deploy.params.CIDR].flat(), ['10.3.0.0/20']);
  assert.deepEqual([deploy.params.VLANRangeStart].flat().map(Number), [300]);
});

test('staging follows Holodeck\'s bill of materials', () => {
  const p = staging1;
  const byVersion = Object.fromEntries(p.versions.map((v) => [v.version, v]));
  assert.deepEqual(p.versions.map((v) => v.version), ['9.1.0.0', '9.0.2.0', '5.2.4']);
  assert.equal(byVersion['9.1.0.0'].status, 'ready');
  assert.equal(byVersion['9.1.0.0'].installerKind, 'vcf-installer');
  assert.equal(byVersion['5.2.4'].installerKind, 'cloud-builder');
  assert.equal(byVersion['5.2.4'].status, 'missing');
  // Present but under a name the precheck rejects.
  assert.equal(byVersion['9.0.2.0'].status, 'incomplete');
  assert.deepEqual(byVersion['9.0.2.0'].other.map((f) => f.name), ['esx-9.0.2.0100.iso']);
  // Remote listings: only files directly in a known version folder count; partial copies are hidden.
  const bom = parseBom(fs.readFileSync(path.join(holoRoot, 'templates', 'bom.json'), 'utf8'));
  const files = parseListing('9.1.0.0/esx-9.1.iso\t10\n9.1.0.0/.inst-9.1.ova.holoportal-partial\t5\ncustomiso/x.iso\t1\n9.1.0.0/sub/y\t1\n', Object.keys(bom));
  const r = evaluateStaging(bom, files).versions.find((v) => v.version === '9.1.0.0')!;
  assert.equal(r.status, 'incomplete');
  assert.equal(r.esx?.size, 10);
  assert.equal(r.installer, null);
  assert.deepEqual(r.other, []);
});

test('with every router busy, deployment is refused', () => {
  assert.equal(pickRouter(user()), null);
  assert.match(deployPreflight(user(), getConfig(1)).join(' '), /capacity is in use|No Holorouter is free/);
  stopJobLoop();
  assert.equal(getLab(1)!.status, 'queued');
});

test('import checks block foreign instances, missing webtop and pre-configured networks', () => {
  run(
    `INSERT INTO holorouters (id, name, address, slot, origin, profile_id, status, inspection) VALUES (3, 'hr3', '192.0.2.3', 3, 'imported', 1, 'onboarding', ?)`,
    JSON.stringify({
      holodeckVersion: '9.1.0.20',
      webtop: { httpStatus: '000', ok: false },
      kubernetes: { reachable: true, pods: 9, notReady: [] },
      nics: [{ name: 'eth1', present: true }, { name: 'eth2', present: true }],
      instances: ['old1'],
      configs: [{ file: 'x-site-a.json', instanceId: 'old1', holorouterStatus: 'Configured' }],
      startupScript: true,
    }),
  );
  const { blockers } = evaluate(getRouter(3)!, true);
  assert.ok(blockers.some((b) => /webtop/i.test(b)));
  assert.ok(blockers.some((b) => /old1/.test(b)));
  assert.ok(blockers.some((b) => /already configured/.test(b)));
  // Once the portal manages the router, its own network configuration is expected.
  run("UPDATE holorouters SET inspection = ? WHERE id = 3", JSON.stringify({
    holodeckVersion: '9.1.0.20', webtop: { httpStatus: '401', ok: true }, kubernetes: { reachable: true, pods: 9, notReady: [] },
    nics: [{ name: 'eth1', present: true }, { name: 'eth2', present: true }], instances: [], configs: [{ file: 'x-site-a.json', instanceId: null, holorouterStatus: 'Configured' }], startupScript: true,
  }));
  assert.deepEqual(evaluate(getRouter(3)!, false).blockers, []);
  // A fresh OVA (stub startup script, no VLAN interfaces, no configs) passes the import checks.
  run("UPDATE holorouters SET inspection = ? WHERE id = 3", JSON.stringify({
    holodeckVersion: '9.1.0.20', webtop: { httpStatus: '401', ok: true }, kubernetes: { reachable: true, pods: 9, notReady: [] },
    nics: [{ name: 'eth1', present: true }, { name: 'eth2', present: true }], instances: [], configs: [], startupScript: false, vlanInterfaces: 0,
  }));
  assert.deepEqual(evaluate(getRouter(3)!, true).blockers, []);
  // Leftover VLAN interfaces alone still count as configured networks.
  run("UPDATE holorouters SET inspection = json_set(inspection, '$.vlanInterfaces', 21) WHERE id = 3");
  assert.ok(evaluate(getRouter(3)!, true).blockers.some((b) => /already configured/.test(b)));
});

test('router deployment needs an authenticated OVA and an approved vCenter, and confirms the host key', async () => {
  const { deployRouter } = await import('../holorouters.js');
  const input = {
    profileId: 1, vmName: 'hr9', hostname: 'hr9', ip: '192.0.2.99', prefix: 24, gateway: '192.0.2.1',
    dnsServer: '192.0.2.1', dnsDomain: 'example.com', ntpServer: '192.0.2.1', password: FAKE_PW, gitops: false,
  };
  const sha = 'a'.repeat(64);
  const cert = JSON.stringify({ sha256: 'AA:BB', sha1: 'CC:DD', subject: 'vc', notAfter: '2030-01-01' });
  // Plain HTTP without a digest: refused before anything is created.
  updateSettings('holorouters', { ovaUrl: 'http://depot.example.com/hr.ova', ovaSha256: '' });
  assert.throws(() => deployRouter(admin(), input), /plain HTTP.*SHA-256/);
  // HTTPS without a digest is fine, unless the admin requires one.
  updateSettings('holorouters', { ovaUrl: 'https://depot.example.com/hr.ova', requireOvaDigest: true });
  assert.throws(() => deployRouter(admin(), input), /require an approved SHA-256/);
  // A digest, but the profile's vCenter certificate is not approved.
  updateSettings('holorouters', { ovaUrl: 'http://depot.example.com/hr.ova', ovaSha256: sha, requireOvaDigest: false });
  assert.throws(() => deployRouter(admin(), input), /Approve the vCenter certificate/);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM holorouters WHERE name = 'hr9'")!.n, 0);
  // Both in place: the job pins vCenter, checks the digest and confirms the SSH key before onboarding.
  run('UPDATE capacity_profiles SET vcenter_thumbprint = ? WHERE id = 1', cert);
  const sshDir = path.join(process.env.HP_DATA_DIR!, 'ssh');
  fs.mkdirSync(sshDir, { recursive: true });
  fs.writeFileSync(path.join(sshDir, 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4test holodeck-portal\n');
  const { job } = deployRouter(admin(), input);
  const spec = JSON.parse(fs.readFileSync(path.join(process.env.HP_DATA_DIR!, 'jobs', job.id, 'job.json'), 'utf8'));
  const cmds = spec.steps.map((s: { command: string }) => s.command);
  assert.deepEqual(cmds.slice(1), ['HP-FetchOva', 'HP-DeployRouter', 'HP-WaitRouterReady', 'HP-OnboardDeployedRouter']);
  const step = (c: string) => spec.steps.find((s: { command: string }) => s.command === c).params;
  assert.equal(step('HP-FetchOva').Sha256, sha);
  assert.deepEqual([step('HP-DeployRouter').VCenterSha256, step('HP-DeployRouter').VCenterSha1, step('HP-DeployRouter').OvaSha256], ['AA:BB', 'CC:DD', sha]);
  const onboard = step('HP-OnboardDeployedRouter');
  assert.deepEqual([onboard.Address, onboard.VMName, onboard.VCenterSha256], ['192.0.2.99', 'hr9', 'AA:BB']);
  assert.match(onboard.PublicKey, /^ssh-ed25519 /);
  run('UPDATE capacity_profiles SET vcenter_thumbprint = NULL WHERE id = 1');
});

test('imports renew the shipped SSH host key; shared keys are flagged and can be renewed', async () => {
  const { importRouter, renewHostKey, sharesHostKey, routerView } = await import('../holorouters.js');
  const { router, job } = importRouter(admin(), { address: '192.0.2.77', password: FAKE_PW, profileId: 1, hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43) });
  const spec = JSON.parse(fs.readFileSync(path.join(process.env.HP_DATA_DIR!, 'jobs', job.id, 'job.json'), 'utf8'));
  assert.deepEqual(spec.steps.map((s: { command: string }) => s.command), ['HP-RouterOnboard', 'HP-RenewHostKey']);
  // Two routers presenting the same pinned key: both are flagged.
  run("UPDATE holorouters SET host_key = 'ssh-ed25519 SHA256:shared', status = 'ready' WHERE id IN (2, ?)", router.id);
  assert.equal(sharesHostKey(getRouter(2)!), true);
  assert.equal(routerView(getRouter(router.id)!).hostKeyShared, true);
  assert.throws(() => renewHostKey(admin(), getRouter(router.id)!), /import job is running|router-onboard job is running/);
  run("UPDATE jobs SET status = 'succeeded' WHERE id = ?", job.id);
  const rk = renewHostKey(admin(), getRouter(router.id)!);
  const rspec = JSON.parse(fs.readFileSync(path.join(process.env.HP_DATA_DIR!, 'jobs', rk.id, 'job.json'), 'utf8'));
  assert.deepEqual(rspec.steps.map((s: { command: string; params: { Address: string } }) => [s.command, s.params.Address]), [['HP-RenewHostKey', '192.0.2.77']]);
  // A second renewal while one is running is refused.
  assert.throws(() => renewHostKey(admin(), getRouter(router.id)!), /running/);
  run("UPDATE holorouters SET host_key = 'ssh-ed25519 SHA256:own' WHERE id = 2");
  assert.equal(sharesHostKey(getRouter(2)!), false);
  // The last router still on a shipped key stays flagged once others have renewed: the key a renewal replaced is known.
  run("INSERT INTO audit (action, details) VALUES ('holorouter.rekey', ?)", JSON.stringify({ previous: 'ssh-ed25519 SHA256:shipped' }));
  run("UPDATE holorouters SET host_key = 'ssh-ed25519 SHA256:shipped' WHERE id = ?", router.id);
  assert.equal(sharesHostKey(getRouter(router.id)!), true);
});

test('strict vCenter sign-in only for vCenter targets with an approval that has the CA', async () => {
  const { deployRouter, strictTrustReady } = await import('../holorouters.js');
  run("UPDATE labs SET status = 'removed' WHERE holorouter_id > 2");
  run('DELETE FROM holorouters WHERE id > 2');
  const { getConfigFile, putConfigFile } = await import('../holodeck/configstore.js');
  const original = getConfigFile('test', 'a');
  const withApi = (apiType: string | null) => putConfigFile('test', 'a', { ...original, Target: { hostname: 'vc.example', targetHostApiType: apiType } });
  updateSettings('holorouters', { ovaUrl: 'https://depot.example.com/hr.ova', ovaSha256: 'b'.repeat(64), requireOvaDigest: false, strictVcenterTrust: true });
  const ca = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
  let n = 0;
  const deploy = () => {
    n += 1;
    const { job } = deployRouter(admin(), {
      profileId: 1, vmName: `st${n}`, hostname: `st${n}`, ip: `192.0.2.${150 + n}`, prefix: 24, gateway: '192.0.2.1',
      dnsServer: '192.0.2.1', dnsDomain: 'example.com', ntpServer: '192.0.2.1', password: FAKE_PW, gitops: false,
    });
    const spec = JSON.parse(fs.readFileSync(path.join(process.env.HP_DATA_DIR!, 'jobs', job.id, 'job.json'), 'utf8'));
    // The runner must export the bundle before pwsh starts (OpenSSL ignores variables set inside PowerShell).
    const marker = path.join(process.env.HP_DATA_DIR!, 'jobs', job.id, 'ssl-cert-file');
    assert.equal(fs.existsSync(marker), Boolean(spec.env.SSL_CERT_FILE));
    if (spec.env.SSL_CERT_FILE) assert.equal(fs.readFileSync(marker, 'utf8'), spec.env.SSL_CERT_FILE);
    run("UPDATE holorouters SET status = 'removing' WHERE name = ?", `st${n}`);
    run("DELETE FROM holorouters WHERE name = ?", `st${n}`);
    return { env: spec.env, params: spec.steps.find((s: { command: string }) => s.command === 'HP-DeployRouter').params };
  };
  const approve = (extra: Record<string, unknown>) =>
    run('UPDATE capacity_profiles SET vcenter_thumbprint = ? WHERE id = 1', JSON.stringify({ host: 'vc.example', sha256: 'AA', sha1: 'BB', subject: '', issuer: '', validTo: '', ...extra }));

  withApi('VirtualCenter');
  approve({ caPem: ca, nameMatches: true });
  assert.equal(strictTrustReady({ caPem: ca, nameMatches: true } as never), true);
  let d = deploy();
  assert.equal(d.params.StrictTrust, true);
  assert.match(d.env.SSL_CERT_FILE, /trust\/profile-1\.pem$/);
  assert.ok(fs.readFileSync(d.env.SSL_CERT_FILE, 'utf8').trimEnd().endsWith(ca.split('\n').pop()!));
  // An approval from before (no CA): deploys as before, and the log asks for a re-approval.
  approve({});
  d = deploy();
  assert.equal(d.params.StrictTrust, undefined);
  assert.equal(d.params.StrictTrustNote, 'reapprove');
  assert.equal(d.env.SSL_CERT_FILE, undefined);
  // Certificate not issued for the configured name.
  approve({ caPem: ca, nameMatches: false });
  assert.equal(deploy().params.StrictTrustNote, 'name');
  // Standalone ESXi target: never strict, no note.
  withApi('HostAgent');
  approve({ caPem: ca, nameMatches: true });
  d = deploy();
  assert.deepEqual([d.params.StrictTrust, d.params.StrictTrustNote, d.env.SSL_CERT_FILE], [undefined, undefined, undefined]);
  // Turned off by the administrator.
  withApi('VirtualCenter');
  updateSettings('holorouters', { ...getSettings().holorouters, strictVcenterTrust: false });
  d = deploy();
  assert.deepEqual([d.params.StrictTrust, d.params.StrictTrustNote], [undefined, undefined]);
  putConfigFile('test', 'a', original);
  run('UPDATE capacity_profiles SET vcenter_thumbprint = NULL WHERE id = 1');
});

test('ESXi-only targets: no cluster for Holodeck, and unlicensed hosts are refused with the import route', async () => {
  const { deployRouter, profileView } = await import('../holorouters.js');
  const { holodeckEnv } = await import('../labs.js');
  run("UPDATE labs SET status = 'removed' WHERE holorouter_id > 2");
  run('DELETE FROM holorouters WHERE id > 2');
  const { getConfigFile, putConfigFile } = await import('../holodeck/configstore.js');
  const original = getConfigFile('test', 'a');
  putConfigFile('test', 'a', { ...original, Target: { hostname: 'esxi.example', targetHostApiType: 'HostAgent', cluster: 'C', resourcePool: 'RP' } });
  run("UPDATE capacity_profiles SET cluster = 'esxi.', resource_pool = '' WHERE id = 1");
  // A lab on a router of this profile: datastore and trunk, but no cluster or resource pool for Holodeck.
  const env = holodeckEnv(getConfig(1)!, { holorouter_id: 2 });
  assert.equal(env.cluster_name, undefined);
  assert.equal(env.resource_pool_name, undefined);
  assert.equal(env.datastore_name, 'DS2');
  assert.equal(env.trunk_port_group_name, 'TrunkA2');
  // Licence from the last inventory read: evaluation is fine, the free licence is not.
  const inv = (license: object) =>
    run("INSERT INTO vcenter_inventory (config_id, data, fetched_at) VALUES (1, ?, 'now') ON CONFLICT(config_id) DO UPDATE SET data = excluded.data",
      JSON.stringify({ apiType: 'HostAgent', datacenters: [], license }));
  inv({ edition: 'esx.hypervisor.free', evaluation: false, hoursLeft: null, writable: false });
  assert.equal(profileView(get('SELECT * FROM capacity_profiles WHERE id = 1')!).targetType, 'esxi');
  updateSettings('holorouters', { ovaUrl: 'https://depot.example.com/hr.ova', ovaSha256: 'c'.repeat(64), requireOvaDigest: false });
  run('UPDATE capacity_profiles SET vcenter_thumbprint = ? WHERE id = 1', JSON.stringify({ host: 'esxi.example', sha256: 'AA', sha1: 'BB', subject: '', issuer: '', validTo: '' }));
  const input = {
    profileId: 1, vmName: 'esx1', hostname: 'esx1', ip: '192.0.2.181', prefix: 24, gateway: '192.0.2.1',
    dnsServer: '192.0.2.1', dnsDomain: 'example.com', ntpServer: '192.0.2.1', password: FAKE_PW, gitops: false,
  };
  assert.throws(() => deployRouter(admin(), input), /free ESXi licence.*Import existing/);
  inv({ edition: 'esx.eval.entitlement.cpuCoreMin', evaluation: true, hoursLeft: 0, writable: false });
  assert.throws(() => deployRouter(admin(), input), /evaluation period has ended/);
  inv({ edition: 'esx.eval.entitlement.cpuCoreMin', evaluation: true, hoursLeft: 2000, writable: true });
  const { job } = deployRouter(admin(), input);
  const spec = JSON.parse(fs.readFileSync(path.join(process.env.HP_DATA_DIR!, 'jobs', job.id, 'job.json'), 'utf8'));
  const deploy = spec.steps.find((s: { command: string }) => s.command === 'HP-DeployRouter').params;
  assert.deepEqual([deploy.Cluster, deploy.StrictTrust, deploy.StrictTrustNote, spec.env.SSL_CERT_FILE], ['esxi.', undefined, undefined, undefined]);
  putConfigFile('test', 'a', original);
  run("UPDATE capacity_profiles SET cluster = 'Cluster2', vcenter_thumbprint = NULL WHERE id = 1");
  run('DELETE FROM vcenter_inventory WHERE config_id = 1');
});

test('staging copies from any router with a complete copy, same Holodeck version first', () => {
  run("UPDATE holorouters SET holodeck_version = '9.1.0.20' WHERE id IN (1, 2)");
  // Both have 9.1 complete: for a third router, the lowest slot wins.
  assert.equal(stagingSource('9.1.0.0', { id: 99, holodeck_version: '9.1.0.20' })!.router.id, 1);
  // Never the target itself.
  assert.equal(stagingSource('9.1.0.0', getRouter(1)!)!.router.id, 2);
  // Prefer a source on the target's Holodeck version.
  run("UPDATE holorouters SET holodeck_version = '9.1.1.0' WHERE id = 2");
  assert.equal(stagingSource('9.1.0.0', { id: 99, holodeck_version: '9.1.1.0' })!.router.id, 2);
  // Incomplete or missing everywhere: no source.
  assert.equal(stagingSource('9.0.2.0'), null);
  assert.equal(stagingSource('5.2.4'), null);
  const fleet = fleetStaging().versions.find((v) => v.version === '9.1.0.0')!;
  assert.deepEqual([fleet.status, fleet.sources.sort()], ['ready', ['hr1', 'hr2']]);
});

test('a first router can be imported without a capacity profile and then serves any configuration', async () => {
  const { importRouter, routerServesConfig } = await import('../holorouters.js');
  const { router } = importRouter(admin(), { address: '192.0.2.88', password: FAKE_PW, profileId: null, hostKeyFingerprint: 'SHA256:' + 'B'.repeat(43) });
  const r = getRouter(router.id)!;
  assert.equal(r.profile_id, null);
  assert.equal(routerServesConfig(r, 1), true);
  assert.equal(routerServesConfig(r, 999), true);
  assert.equal(get<{ details: string }>("SELECT details FROM audit WHERE action = 'holorouter.import' ORDER BY id DESC LIMIT 1")!.details.includes('"profile":null'), true);
});
