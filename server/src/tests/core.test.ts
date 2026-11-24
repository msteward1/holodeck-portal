import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir before any module that opens the database is loaded.
process.env.HP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-test-'));

const { describeSlot, slotCount, validatePool } = await import('../network.js');
const { buildNewInstanceParams, normalizeDeployOptions, usesSharedRoutedNetworks, coerceFields, buildDay2Params } = await import('../holodeck/catalog.js');
const { curateCredentials, consoleLinks } = await import('../holodeck/credentials.js');
const { roleFor } = await import('../auth/sso.js');
const { cleanTerminal, pendingPrompt, jobDir } = await import('../holodeck/jobs.js');
const { getSettings } = await import('../settings.js');

const net = getSettings().network;

test('default pool gives five labs, each with two /20s and x100 VLANs', () => {
  assert.equal(slotCount(net), 5);
  assert.deepEqual(
    describeSlot(net, 1).sites.map((s) => [s.site, s.cidr, s.vlanStart, s.reserved]),
    [
      ['a', '10.1.0.0/20', 100, false],
      ['b', '10.2.0.0/20', 200, true],
    ],
  );
  assert.deepEqual(
    describeSlot(net, 5).sites.map((s) => [s.cidr, s.vlanStart]),
    [
      ['10.9.0.0/20', 900],
      ['10.10.0.0/20', 1000],
    ],
  );
  assert.deepEqual(validatePool(net), []);
});

test('pool validation catches VLAN overflow and overlapping ranges', () => {
  assert.ok(validatePool({ ...net, secondOctetEnd: 60 }).some((p) => p.includes('beyond 4094')));
  assert.ok(validatePool({ ...net, vlanMultiplier: 10 }).some((p) => p.includes('overlap')));
  assert.ok(validatePool({ ...net, secondOctetStart: 5, secondOctetEnd: 5 }).some((p) => p.includes('too small')));
});

test('deploy options are filtered to the chosen mode and version', () => {
  const vvf = normalizeDeployOptions({
    mode: 'VVF',
    version: '9.1.0.0',
    WorkloadDomainType: 'IsolatedSSO',
    NsxEdgeClusterMgmtDomain: true,
    ProvisionOnly: true,
    vSANMode: 'ESA',
  });
  assert.deepEqual(vvf, { mode: 'VVF', version: '9.1.0.0', ProvisionOnly: true, vSANMode: 'ESA' });

  const v52 = normalizeDeployOptions({ mode: 'FullStack', version: '5.2.1', DeployVcfAutomation: true, NsxEdgeClusterWkldDomain: true });
  assert.equal(v52.DeployVcfAutomation, undefined, 'VCF Automation is 9.x only');
  assert.equal(v52.NsxEdgeClusterWkldDomain, true);
});

test('New-HoloDeckInstance parameters carry the allocated CIDR/VLAN and run unattended', () => {
  const p = buildNewInstanceParams(
    { mode: 'ManagementOnly', version: '9.1.0.0', DeploySupervisorMgmtDomain: 'Distributed', DepotType: 'Offline' },
    'lab01',
    { site: 'a', cidr: '10.3.0.0/20', vlanStart: 300 },
  );
  assert.deepEqual(p, {
    Version: '9.1.0.0',
    InstanceID: 'lab01',
    CIDR: ['10.3.0.0/20'],
    VLANRangeStart: [300],
    Site: 'a',
    DepotType: 'Offline',
    LogLevel: 'INFO',
    DeveloperMode: true,
    ManagementOnly: true,
    DeploySupervisorMgmtDomain: 'Distributed',
  });
  assert.equal(usesSharedRoutedNetworks({ mode: 'ManagementOnly', version: '9.1.0.0', DeploySupervisorMgmtDomain: 'Distributed' }), true);
  assert.equal(usesSharedRoutedNetworks({ mode: 'FullStack', version: '9.1.0.0' }), false);
});

test('form values are coerced and validated', () => {
  const out = coerceFields(
    [
      { name: 'n', label: 'N', type: 'number', required: true },
      { name: 'l', label: 'L', type: 'list' },
      { name: 's', label: 'S', type: 'select', options: ['A', 'B'] },
      { name: 'b', label: 'B', type: 'boolean' },
    ],
    { n: '4', l: '40, 400,', s: 'B', b: false },
  );
  assert.deepEqual(out, { n: 4, l: ['40', '400'], s: 'B' });
  assert.throws(() => coerceFields([{ name: 's', label: 'S', type: 'select', options: ['A'] }], { s: 'Z' }));
  assert.throws(() => coerceFields([{ name: 'n', label: 'N', type: 'number', required: true }], {}));
  assert.deepEqual(buildDay2Params('AddCluster', { VIDomain: 'Workload' }, 'a'), { Site: 'a', AdditionalCluster: true, VIDomain: 'Workload' });
});

test('credentials are labelled, version-filtered and de-duplicated', () => {
  const creds = curateCredentials(
    [
      { path: 'cb-management-domain.hostSpecs[0].credentials.password', username: null, password: 'cb-only' },
      { path: 'vcf-installer-management-domain.management-domain-spec.hostSpecs[0].credentials.password', username: 'root', password: 'esxpw' },
      { path: 'vcf-installer-management-domain.management-domain-spec.hostSpecs[1].credentials.password', username: 'root', password: 'esxpw' },
      { path: 'vcf-installer-management-domain.management-domain-spec.vcfOperationsFleetManagementSpec.adminUserPassword', username: null, password: 'fleet' },
      { path: 'cloud-builder.adminPassword', username: null, password: 'cb' },
      { path: 'vcf-installer.rootPassword', username: null, password: 'inst' },
      { path: 'vcf-installer-management-domain.management-domain-spec.vcenterSpec.adminUserSsoPassword', username: null, password: 'sso' },
      { path: 'vvf-9-0.something.password', username: null, password: 'old' },
      { path: 'bgp.password', username: null, password: 'bgp' },
    ],
    '9.1.0.0',
  );
  assert.deepEqual(
    creds.map((c) => `${c.component}|${c.account}|${c.password}`),
    [
      'BGP|Peer password|bgp',
      'ESX hosts|root|esxpw',
      'vCenter|administrator@vsphere.local|sso',
      'VCF Installer|root|inst',
      'VCF Operations Fleet Management|admin@local|fleet',
    ],
  );
});

test('console links follow the deployment mode', () => {
  const eps = [
    { hostname: 'vc-mgmt-a', fqdn: 'vc-mgmt-a.site-a.vcf.lab', ip: '10.1.1.10' },
    { hostname: 'sddcmanager-a', fqdn: 'sddcmanager-a.site-a.vcf.lab', ip: '10.1.1.5' },
    { hostname: 'vc-wld01-a', fqdn: 'vc-wld01-a.site-a.vcf.lab', ip: '10.1.1.11' },
  ];
  assert.deepEqual(consoleLinks(eps, 'VVF', []).map((l) => l.label), ['vCenter (management)']);
  assert.deepEqual(consoleLinks(eps, 'FullStack', []).map((l) => l.label), ['vCenter (management)', 'SDDC Manager', 'vCenter (workload)']);
});

test('IdP groups map to roles', () => {
  const rules = { adminGroups: ['Portal Admins'], userGroups: ['lab-users'], autoProvision: true };
  assert.equal(roleFor(['portal admins'], rules), 'admin');
  assert.equal(roleFor(['lab-users'], rules), 'user');
  assert.equal(roleFor(['other'], rules), null);
  assert.equal(roleFor([], { ...rules, userGroups: [] }), 'user');
});

test('terminal output keeps colours, drops control sequences and prompt markers', () => {
  const raw = '\x1b]0;title\x07\x1b[?1h\x1b=\x1b[36m==> Step\x1b[0m\r\n@@HOLOPORTAL_PROMPT@@{"prompt":"x","secure":false}\r\nprogress 10%\rprogress 100%\r\ndone\r\n';
  assert.equal(cleanTerminal(raw), '\x1b[36m==> Step\x1b[0m\nprogress 100%\ndone\n');
});

test('a prompt is pending until it has been answered', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'output.log'),
    'start\n@@HOLOPORTAL_PROMPT@@{"prompt":"Token","secure":true}\nmore\n@@HOLOPORTAL_PROMPT@@{"prompt":"Continue? (y | n)","secure":false}\n',
  );
  assert.deepEqual(pendingPrompt(id), { prompt: 'Continue? (y | n)', secure: false, index: 1 });
  fs.writeFileSync(path.join(dir, 'answered'), '2');
  assert.equal(pendingPrompt(id), null);
});
