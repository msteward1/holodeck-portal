/**
 * Security regression tests: SSO account binding, SAML replay, day-2 host limits, sessions, sign-in throttling,
 * lab transfer, router host keys and OVA settings.
 * Everything runs in-process with app.inject() against a throwaway database; no job is executed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-sec-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_HOLODECK_ROOT = path.join(tmp, 'holo');
process.env.HP_PUBLIC_URL = 'https://portal.test';
process.env.HP_SYSTEMD_RUN = '0';
process.env.HP_LOG_LEVEL = 'silent';
process.env.HP_WEB_DIST = path.join(tmp, 'no-web');

const { run, get } = await import('../db.js');
const { hashPassword } = await import('../crypto.js');
const { buildApp } = await import('../app.js');
const { upsertSsoUser } = await import('../auth/sso.js');
const { resetLoginCounters } = await import('../auth/session.js');
const { updateSettings } = await import('../settings.js');

const app = await buildApp();
run("INSERT INTO holorouters (id, name, address, mgmt_ip, slot, origin, status) VALUES (1, 'hr1', '192.0.2.1', '192.0.2.1', 1, 'imported', 'ready')");
const H = { 'x-holoportal': '1' };
const PW = 'correct horse battery';

run("INSERT INTO configs (id, config_id, name, entitle_all) VALUES (1, 'test', 'Test', 1)");
for (const [id, name, role] of [
  [1, 'admin', 'admin'],
  [2, 'alice', 'user'],
  [3, 'bob', 'user'],
] as const) {
  run('INSERT INTO users (id, username, role, first_name, last_name, password_hash) VALUES (?, ?, ?, ?, ?, ?)', id, name, role, name, 'T', await hashPassword(PW));
}

function makeLab(id: number, owner: number, nodes: string[] = []) {
  run(
    `INSERT INTO labs (id, instance_id, name, owner_id, config_id, slot, sites, version, mode, status, power_state, lease_expires_at, holorouter_id, nodes)
     VALUES (?, ?, ?, ?, 1, ?, '[]', '9.1.0.0', 'VVF', 'ready', 'on', ?, 1, ?)`,
    id,
    `i${id}`,
    `Lab ${id}`,
    owner,
    id,
    new Date(Date.now() + 86400_000).toISOString(),
    JSON.stringify(nodes.map((n) => ({ name: n, ip: '192.0.2.1', type: 'ESX_Host' }))),
  );
}

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const c = list.find((x) => x.startsWith(`${name}=`) && !x.startsWith(`${name}=;`));
  return c ? c.split(';')[0] : null;
}

async function login(username: string, password = PW, ip = '10.9.9.9') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { username, password }, remoteAddress: ip });
  return { res, cookie: cookieFrom(res, 'hp_session') };
}

const me = (cookie: string) => app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } }).then((r) => r.json().user?.username ?? null);

// --------------------------------------------------------------------------- sessions

test('changing the password signs out other sessions and rotates this one', async () => {
  resetLoginCounters();
  const a = (await login('alice')).cookie!;
  const b = (await login('alice')).cookie!;
  assert.equal(await me(b), 'alice');
  const res = await app.inject({ method: 'POST', url: '/api/auth/password', headers: { ...H, cookie: a }, payload: { current: PW, next: 'a brand new password' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().revokedSessions, 1);
  const rotated = cookieFrom(res, 'hp_session');
  assert.ok(rotated && rotated !== a, 'a new session cookie is issued');
  assert.equal(await me(b), null, 'the other session is gone');
  assert.equal(await me(a), null, 'the old token of this session is gone');
  assert.equal(await me(rotated!), 'alice');
  run('UPDATE users SET password_hash = ? WHERE id = 2', await hashPassword(PW));
});

test('"sign out other sessions" keeps only the current one', async () => {
  resetLoginCounters();
  const a = (await login('bob')).cookie!;
  const b = (await login('bob')).cookie!;
  const list = await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: a } });
  assert.ok(list.json().sessions.length >= 2);
  assert.equal(list.json().sessions.filter((s: { current: boolean }) => s.current).length, 1);
  const res = await app.inject({ method: 'POST', url: '/api/auth/sessions/revoke-others', headers: { ...H, cookie: a } });
  assert.ok(res.json().revokedSessions >= 1);
  assert.equal(await me(a), 'bob');
  assert.equal(await me(b), null);
});

// --------------------------------------------------------------------------- sign-in throttling

test('simultaneous wrong passwords cannot exceed the per-account budget', async () => {
  resetLoginCounters();
  const results = await Promise.all(Array.from({ length: 14 }, () => login('alice', 'wrong password', '10.1.1.1')));
  const codes = results.map((r) => r.res.statusCode);
  assert.equal(codes.filter((c) => c === 401).length, 10);
  assert.equal(codes.filter((c) => c === 429).length, 4);
  // The right password is refused too while the budget is used up; another address is unaffected.
  assert.equal((await login('alice', PW, '10.1.1.1')).res.statusCode, 429);
  assert.equal((await login('alice', PW, '10.1.1.2')).res.statusCode, 200);
});

test('one address spraying many usernames hits the per-address budget', async () => {
  resetLoginCounters();
  const codes: number[] = [];
  for (let i = 0; i < 55; i++) codes.push((await login(`nobody${i}`, 'x', '10.2.2.2')).res.statusCode);
  assert.equal(codes.filter((c) => c === 401).length, 50);
  assert.ok(codes.slice(50).every((c) => c === 429));
});

test('a successful sign-in gives its attempt back', async () => {
  resetLoginCounters();
  for (let i = 0; i < 60; i++) assert.equal((await login('bob', PW, '10.3.3.3')).res.statusCode, 200);
});

// --------------------------------------------------------------------------- lab transfer

test('after a transfer the former owner loses the lab\'s jobs; busy labs cannot be transferred', async () => {
  resetLoginCounters();
  makeLab(10, 2);
  const jobId = randomUUID();
  run(
    "INSERT INTO jobs (id, type, lab_id, config_id, user_id, status, prompt) VALUES (?, 'lab-deploy', 10, 1, 2, 'waiting_input', ?)",
    jobId,
    JSON.stringify({ prompt: 'Continue?', secure: false, index: 0 }),
  );
  const admin = (await login('admin')).cookie!;
  const alice = (await login('alice')).cookie!;
  const bob = (await login('bob')).cookie!;

  const busy = await app.inject({ method: 'PATCH', url: '/api/labs/10', headers: { ...H, cookie: admin }, payload: { ownerId: 3 } });
  assert.equal(busy.statusCode, 409);

  run("UPDATE jobs SET status = 'succeeded', prompt = NULL, finished_at = ? WHERE id = ?", new Date().toISOString(), jobId);
  const moved = await app.inject({ method: 'PATCH', url: '/api/labs/10', headers: { ...H, cookie: admin }, payload: { ownerId: 3 } });
  assert.equal(moved.statusCode, 200);
  run("UPDATE jobs SET status = 'waiting_input', prompt = ? WHERE id = ?", JSON.stringify({ prompt: 'Continue?', secure: false, index: 0 }), jobId);

  for (const [method, url, payload] of [
    ['GET', `/api/jobs/${jobId}`, undefined],
    ['GET', `/api/jobs/${jobId}/log`, undefined],
    ['POST', `/api/jobs/${jobId}/answer`, { value: 'yes' }],
    ['POST', `/api/jobs/${jobId}/cancel`, {}],
  ] as const) {
    const r = await app.inject({ method, url, headers: { ...H, cookie: alice }, payload });
    assert.equal(r.statusCode, 404, `${method} ${url} as former owner`);
  }
  assert.equal((await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie: bob } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie: admin } })).statusCode, 200);
  const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: alice } });
  assert.ok(!list.json().jobs.some((j: { id: string }) => j.id === jobId));
  run("UPDATE jobs SET status = 'succeeded', prompt = NULL WHERE id = ?", jobId);
});

// --------------------------------------------------------------------------- SSO account binding

const rules = { adminGroups: [], userGroups: [], autoProvision: false };

test('an SSO sign-in never re-binds an account already linked to another subject', () => {
  run("INSERT INTO users (id, username, role, auth_source, external_id) VALUES (20, 'victim', 'user', 'oidc', 'subject-victim')");
  assert.throws(() => upsertSsoUser({ source: 'oidc', issuer: 'https://idp.test', externalId: 'subject-attacker', username: 'victim', groups: [] }, rules), /linked to a different/);
  assert.throws(() => upsertSsoUser({ source: 'oidc', issuer: 'https://idp.test', externalId: 'subject-attacker', username: 'VICTIM', groups: [] }, rules), /linked to a different/);
  assert.equal(get<{ external_id: string }>('SELECT external_id FROM users WHERE id = 20')!.external_id, 'subject-victim');
  assert.equal(upsertSsoUser({ source: 'oidc', issuer: 'https://idp.test', externalId: 'subject-victim', username: 'victim-renamed', groups: [] }, rules).id, 20);
});

test('a pre-created account links once, and again after an admin unlinks it', async () => {
  resetLoginCounters();
  run("INSERT INTO users (id, username, role, auth_source) VALUES (21, 'precreated', 'user', 'saml')");
  assert.equal(upsertSsoUser({ source: 'saml', issuer: 'https://idp.test', externalId: 'nameid-1', username: 'precreated', groups: [] }, rules).id, 21);
  assert.throws(() => upsertSsoUser({ source: 'saml', issuer: 'https://idp.test', externalId: 'nameid-2', username: 'precreated', groups: [] }, rules));
  const admin = (await login('admin')).cookie!;
  const r = await app.inject({ method: 'POST', url: '/api/admin/users/21/unlink-sso', headers: { ...H, cookie: admin } });
  assert.equal(r.statusCode, 200);
  assert.equal(upsertSsoUser({ source: 'saml', issuer: 'https://idp.test', externalId: 'nameid-2', username: 'precreated', groups: [] }, rules).id, 21);
});

// --------------------------------------------------------------------------- host reservations

test('day-2 host sizes are bounded and hosts per site are budgeted', async () => {
  resetLoginCounters();
  run("UPDATE labs SET status = 'removed' WHERE id = 10");
  makeLab(30, 2, ['x-esx-01a', 'x-esx-02a', 'x-esx-03a', 'x-esx-04a']);
  const alice = (await login('alice')).cookie!;
  const day2 = (values: Record<string, unknown>, action = 'NewHostsCustom', cookie = alice) =>
    app.inject({ method: 'POST', url: '/api/labs/30/day2', headers: { ...H, cookie }, payload: { action, values } });
  const ok = { CPU: 12, MemoryInGb: 32, Nodes: 1, DiskSizeInGB: '450, 450' };

  assert.equal((await day2({ ...ok, CPU: 1_000_000 })).statusCode, 400);
  assert.equal((await day2({ ...ok, CPU: 12.5 })).statusCode, 400);
  assert.equal((await day2({ ...ok, MemoryInGb: 4 })).statusCode, 400);
  assert.equal((await day2({ ...ok, DiskSizeInGB: '450, 450, 450, 450' })).statusCode, 400);
  assert.equal((await day2({ ...ok, DiskSizeInGB: '1000000' })).statusCode, 400);
  assert.equal((await day2({ ...ok, DiskSizeInGB: 'abc' })).statusCode, 400);
  // 4 hosts now, 8 allowed: the form never offers more than 4 at once, and a cluster (3) fits.
  assert.equal((await day2({ ...ok, Nodes: 5 })).statusCode, 400);
  const cluster = await day2({ VIDomain: 'Management' }, 'AddCluster');
  assert.equal(cluster.statusCode, 200, cluster.body);
  const jobId = cluster.json().job.id;
  // While it runs, its 3 hosts count: only 1 more would fit (and the lab is busy anyway).
  run("UPDATE jobs SET status = 'succeeded' WHERE id = ?", jobId);
  run('UPDATE labs SET nodes = ? WHERE id = 30', JSON.stringify(['01a', '02a', '03a', '04a', '05a', '06a', '07a'].map((n) => ({ name: `x-esx-${n}`, type: 'ESX_Host' }))));
  assert.equal((await day2({ ...ok, Nodes: 2 })).statusCode, 409);
  const one = await day2({ ...ok, Nodes: 1 });
  assert.equal(one.statusCode, 200, one.body);
  run("UPDATE jobs SET status = 'succeeded' WHERE id = ?", one.json().job.id);
  // The admin limit can go down to 4, which stops further additions; administrators are not held to it.
  updateSettings('hosts', { maxHostsPerSite: 4 });
  assert.equal((await day2({ ...ok, Nodes: 1 })).statusCode, 409);
  const admin = (await login('admin')).cookie!;
  const adm = await day2({ ...ok, Nodes: 1 }, 'NewHostsCustom', admin);
  assert.equal(adm.statusCode, 200, adm.body);
  run("UPDATE jobs SET status = 'succeeded' WHERE id = ?", adm.json().job.id);
  updateSettings('hosts', { maxHostsPerSite: 8 });
});

// --------------------------------------------------------------------------- SAML

test('SAML responses must answer this browser\'s request, once', async () => {
  const { SignedXml } = await import('xml-crypto');
  const keyFile = path.join(tmp, 'idp.key');
  const certFile = path.join(tmp, 'idp.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=idp.test', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const key = fs.readFileSync(keyFile, 'utf8');
  const cert = fs.readFileSync(certFile, 'utf8');
  updateSettings('auth', {
    localEnabled: true,
    oidc: {},
    saml: { enabled: true, entryPoint: 'https://idp.test/sso', idpIssuer: 'https://idp.test', idpCert: cert, adminGroups: [], userGroups: [], autoProvision: true },
  });

  const acs = 'https://portal.test/api/auth/saml/acs';
  const entity = 'https://portal.test/api/auth/saml/metadata';
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  function response(inResponseTo: string, user = 'samluser') {
    const aid = `_a${randomUUID()}`;
    const xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID()}" Version="2.0" IssueInstant="${iso(0)}" Destination="${acs}" InResponseTo="${inResponseTo}">` +
      `<saml:Issuer>https://idp.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      `<saml:Assertion ID="${aid}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>https://idp.test</saml:Issuer>` +
      `<saml:Subject><saml:NameID>${user}-id</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
      `<saml:SubjectConfirmationData InResponseTo="${inResponseTo}" Recipient="${acs}" NotOnOrAfter="${iso(300_000)}"/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${entity}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="${aid}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `</saml:Assertion></samlp:Response>`;
    const sig = new SignedXml({
      privateKey: key,
      publicCert: cert,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
    return Buffer.from(sig.getSignedXml()).toString('base64');
  }
  async function start() {
    const res = await app.inject({ method: 'GET', url: '/api/auth/saml/login' });
    assert.equal(res.statusCode, 302);
    const tx = cookieFrom(res, 'hp_saml_tx')!;
    assert.ok(tx);
    assert.match(String(res.headers['set-cookie']), /SameSite=None/i);
    const id = get<{ key: string }>('SELECT key FROM saml_cache ORDER BY rowid DESC LIMIT 1')!.key;
    return { tx, id };
  }
  const post = (body: string, cookie?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/saml/acs',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      payload: `SAMLResponse=${encodeURIComponent(body)}`,
    });
  const signedIn = (res: Awaited<ReturnType<typeof post>>) => res.statusCode === 302 && res.headers.location === '/' && Boolean(cookieFrom(res, 'hp_session'));

  // A normal SP-initiated login works.
  const one = await start();
  const good = response(one.id);
  assert.ok(signedIn(await post(good, one.tx)), 'valid SP-initiated login');
  // The same response again is refused (request consumed, assertion remembered).
  assert.ok(!signedIn(await post(good, one.tx)), 'replay');
  // Unsolicited: an InResponseTo the portal never issued, or no browser transaction at all.
  const two = await start();
  assert.ok(!signedIn(await post(response('_never-issued'), two.tx)), 'unsolicited');
  assert.ok(!signedIn(await post(response(two.id))), 'no browser transaction cookie (login CSRF)');
  // A response for one browser's request delivered to another browser.
  const three = await start();
  const four = await start();
  assert.ok(!signedIn(await post(response(three.id), four.tx)), 'other browser');
  // Two copies submitted at once: exactly one is accepted.
  const five = await start();
  const twice = response(five.id);
  const both = await Promise.all([post(twice, five.tx), post(twice, five.tx)]);
  assert.equal(both.filter(signedIn).length, 1, 'concurrent duplicates');
});

// --------------------------------------------------------------------------- router host keys, OVA settings, jobs

test('importing a router requires a confirmed host-key fingerprint', async () => {
  resetLoginCounters();
  const admin = (await login('admin')).cookie!;
  const r = await app.inject({
    method: 'POST',
    url: '/api/admin/holorouters/import',
    headers: { ...H, cookie: admin },
    payload: { address: '192.0.2.81', password: 'x', profileId: 1 },
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /hostKeyFingerprint/);
});

test('OVA settings accept only a URL, a SHA-256 and PEM', () => {
  assert.throws(() => updateSettings('holorouters', { ovaUrl: 'ftp://x/y.ova' }));
  assert.throws(() => updateSettings('holorouters', { ovaSha256: 'abc' }));
  assert.throws(() => updateSettings('holorouters', { depotCaPem: 'not a certificate' }));
  const s = updateSettings('holorouters', { ovaUrl: 'https://depot.example.com/r.ova', ovaSha256: 'A'.repeat(64) });
  assert.equal(s.holorouters.ovaSha256, 'a'.repeat(64));
  updateSettings('holorouters', {});
});

test('jobs: a cancelled job that never started leaves no job file (secrets) behind', async () => {
  resetLoginCounters();
  const { createJob, jobDir } = await import('../holodeck/jobs.js');
  const job = createJob({ type: 'router-check', userId: 1, steps: [], env: { SECRET: 'x' } });
  assert.ok(fs.existsSync(path.join(jobDir(job.id), 'job.json')));
  const admin = (await login('admin')).cookie!;
  const r = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: { ...H, cookie: admin } });
  assert.equal(r.statusCode, 200);
  assert.ok(!fs.existsSync(path.join(jobDir(job.id), 'job.json')));
});

test('jobs: unanswered prompts get one reminder, then the job is cancelled', async () => {
  const { expireStalePrompts } = await import('../labs.js');
  run("UPDATE labs SET status = 'removed' WHERE id = 30");
  makeLab(40, 3);
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  const remind = randomUUID();
  const expire = randomUUID();
  run("INSERT INTO jobs (id, type, lab_id, user_id, status, prompt) VALUES (?, 'lab-day2', 40, 3, 'waiting_input', ?)", remind, JSON.stringify({ prompt: 'Q', index: 0, since: hoursAgo(30) }));
  await expireStalePrompts();
  await expireStalePrompts();
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 3 AND dedupe_key LIKE 'prompt-reminder:%'")!.n, 1);
  assert.equal(get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', remind)!.status, 'waiting_input');
  run("UPDATE jobs SET status = 'succeeded' WHERE id = ?", remind);
  run("INSERT INTO jobs (id, type, lab_id, user_id, status, prompt) VALUES (?, 'lab-deploy', 40, 3, 'waiting_input', ?)", expire, JSON.stringify({ prompt: 'Q', index: 0, since: hoursAgo(73) }));
  const { jobDir } = await import('../holodeck/jobs.js');
  fs.mkdirSync(jobDir(expire), { recursive: true });
  await expireStalePrompts();
  const j = get<{ status: string; error: string }>('SELECT status, error FROM jobs WHERE id = ?', expire)!;
  assert.equal(j.status, 'cancelled');
  assert.match(j.error, /no answer within 72 hours/);
  assert.equal(get<{ status: string }>('SELECT status FROM labs WHERE id = 40')!.status, 'failed');
});
