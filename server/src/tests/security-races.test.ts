/**
 * Security regression tests: sign-in and password-change races, host reservations after failed expansions, SSO issuer,
 * the SAML start cap.
 * Everything runs in-process with app.inject() against a throwaway database; no job is executed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-reas-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_HOLODECK_ROOT = path.join(tmp, 'holo');
process.env.HP_PUBLIC_URL = 'https://portal.test';
process.env.HP_SYSTEMD_RUN = '0';
process.env.HP_LOG_LEVEL = 'silent';
process.env.HP_WEB_DIST = path.join(tmp, 'no-web');

const { run, get, all } = await import('../db.js');
const { hashPassword } = await import('../crypto.js');
const { buildApp } = await import('../app.js');
const { upsertSsoUser, samlStart, SAML_CACHE_MAX } = await import('../auth/sso.js');
const { resetLoginCounters, withPasswordSlot } = await import('../auth/session.js');
const { cancelJob } = await import('../holodeck/jobs.js');
const { getLab, labHostBudget } = await import('../labs.js');

const app = await buildApp();
run("INSERT INTO holorouters (id, name, address, mgmt_ip, slot, origin, status) VALUES (1, 'hr1', '192.0.2.1', '192.0.2.1', 1, 'imported', 'ready')");
const H = { 'x-holoportal': '1' };
const PW = 'correct horse battery';
const NEW_PW = 'a brand new password';

run("INSERT INTO configs (id, config_id, name, entitle_all) VALUES (1, 'test', 'Test', 1)");
for (const [id, name, role] of [
  [1, 'admin', 'admin'],
  [2, 'alice', 'user'],
  [3, 'bob', 'user'],
  [4, 'carol', 'user'],
] as const) {
  run('INSERT INTO users (id, username, role, first_name, last_name, password_hash) VALUES (?, ?, ?, ?, ?, ?)', id, name, role, name, 'T', await hashPassword(PW));
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

/** Occupies every password slot until release() is called, so the next check queues (the reviewer's setup). */
function holdSlots(n = 4) {
  const releases: (() => void)[] = [];
  const held = Array.from({ length: n }, () => withPasswordSlot(() => new Promise<void>((r) => releases.push(r))));
  return async () => {
    releases.forEach((r) => r());
    await Promise.all(held);
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

// --------------------------------------------------------------------------- sign-in and password-change races

test('a login queued before an admin password reset is refused afterwards', async () => {
  resetLoginCounters();
  const admin = (await login('admin')).cookie!;
  const release = holdSlots();
  const pending = login('bob'); // old password, waits for a slot
  await tick();
  const reset = await app.inject({ method: 'PATCH', url: '/api/admin/users/3', headers: { ...H, cookie: admin }, payload: { password: NEW_PW } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = 3')!.n, 0);
  await release();
  const res = await pending;
  assert.equal(res.res.statusCode, 401);
  assert.equal(res.cookie, null);
  assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = 3')!.n, 0);
  assert.equal((await login('bob', NEW_PW)).res.statusCode, 200);
});

test('a login queued before the account is disabled is refused afterwards', async () => {
  resetLoginCounters();
  const admin = (await login('admin')).cookie!;
  const release = holdSlots();
  const pending = login('carol');
  await tick();
  const off = await app.inject({ method: 'PATCH', url: '/api/admin/users/4', headers: { ...H, cookie: admin }, payload: { enabled: false } });
  assert.equal(off.statusCode, 200, off.body);
  await release();
  assert.equal((await pending).res.statusCode, 401);
  run('UPDATE users SET enabled = 1 WHERE id = 4');
});

test('a password change racing an admin reset does not undo the reset', async () => {
  resetLoginCounters();
  const admin = (await login('admin')).cookie!;
  const alice = (await login('alice')).cookie!;
  const release = holdSlots();
  const change = app.inject({ method: 'POST', url: '/api/auth/password', headers: { ...H, cookie: alice }, payload: { current: PW, next: 'alice chose this one' } });
  await tick();
  const reset = await app.inject({ method: 'PATCH', url: '/api/admin/users/2', headers: { ...H, cookie: admin }, payload: { password: NEW_PW } });
  assert.equal(reset.statusCode, 200, reset.body);
  await release();
  const res = await change;
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(cookieFrom(res, 'hp_session'), null);
  resetLoginCounters();
  assert.equal((await login('alice', 'alice chose this one')).res.statusCode, 401);
  const ok = await login('alice', NEW_PW);
  assert.equal(ok.res.statusCode, 200);
  assert.equal(await me(ok.cookie!), 'alice');
});

test('two simultaneous password changes: one wins, the other is told to sign in again', async () => {
  resetLoginCounters();
  run('UPDATE users SET password_hash = ? WHERE id = 3', await hashPassword(PW));
  const a = (await login('bob')).cookie!;
  const b = (await login('bob')).cookie!;
  const [r1, r2] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/auth/password', headers: { ...H, cookie: a }, payload: { current: PW, next: 'first new password' } }),
    app.inject({ method: 'POST', url: '/api/auth/password', headers: { ...H, cookie: b }, payload: { current: PW, next: 'second new password' } }),
  ]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 409]);
  const winner = r1.statusCode === 200 ? 'first new password' : 'second new password';
  resetLoginCounters();
  assert.equal((await login('bob', winner)).res.statusCode, 200);
});

// --------------------------------------------------------------------------- host reservations

function makeLab(id: number, owner: number, hosts: number) {
  run(
    `INSERT INTO labs (id, instance_id, name, owner_id, config_id, slot, sites, version, mode, status, power_state, lease_expires_at, holorouter_id, nodes, snapshot_at)
     VALUES (?, ?, ?, ?, 1, ?, '[]', '9.1.0.0', 'VVF', 'ready', 'on', ?, 1, ?, ?)`,
    id,
    `i${id}`,
    `Lab ${id}`,
    owner,
    id,
    new Date(Date.now() + 86400_000).toISOString(),
    JSON.stringify(Array.from({ length: hosts }, (_, i) => ({ name: `x-esx-0${i + 1}a`, ip: '192.0.2.1', type: 'ESX_Host' }))),
    new Date(Date.now() - 60_000).toISOString(),
  );
}

test('a cancelled expansion keeps its hosts reserved until reconciled, and starts a refresh', async () => {
  resetLoginCounters();
  makeLab(40, 2, 4);
  const alice = (await login('alice', NEW_PW)).cookie!;
  const admin = (await login('admin')).cookie!;
  const day2 = (values: Record<string, unknown>, cookie = alice) =>
    app.inject({ method: 'POST', url: '/api/labs/40/day2', headers: { ...H, cookie }, payload: { action: 'NewHostsCustom', values } });
  const four = { CPU: 12, MemoryInGb: 32, Nodes: 4, DiskSizeInGB: '450, 450' };

  const first = await day2(four);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(labHostBudget(getLab(40)!).count, 8);

  // The job fails part-way (modelled by cancelling it): Holodeck may already have created hosts.
  await cancelJob(first.json().job.id);
  const budget = labHostBudget(getLab(40)!);
  assert.equal(budget.count, 8);
  assert.equal(budget.unconfirmed, true);
  const refresh = all<{ type: string; status: string }>("SELECT type, status FROM jobs WHERE lab_id = 40 AND type = 'lab-refresh'");
  assert.deepEqual(refresh.map((j) => [j.type, j.status]), [['lab-refresh', 'queued']]);
  run("UPDATE jobs SET status = 'succeeded' WHERE lab_id = 40 AND type = 'lab-refresh'");

  // Nobody can expand while the count is uncertain, administrators included.
  assert.equal((await day2({ ...four, Nodes: 1 })).statusCode, 409);
  assert.equal((await day2({ ...four, Nodes: 1 }, admin)).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: '/api/labs/40', headers: { cookie: alice } })).json().lab.hosts.unconfirmed, true);

  // A user can't reconcile by hand; an admin can (audited).
  assert.equal((await app.inject({ method: 'POST', url: '/api/labs/40/reconcile-hosts', headers: { ...H, cookie: alice } })).statusCode, 403);
  const rec = await app.inject({ method: 'POST', url: '/api/labs/40/reconcile-hosts', headers: { ...H, cookie: admin } });
  assert.equal(rec.statusCode, 200, rec.body);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE action = 'lab.hosts.reconciled'")!.n, 1);
  assert.equal(labHostBudget(getLab(40)!).unconfirmed, false);
  assert.equal(labHostBudget(getLab(40)!).count, 4);
  const again = await day2(four);
  assert.equal(again.statusCode, 200, again.body);
  run("UPDATE jobs SET status = 'succeeded' WHERE id = ?", again.json().job.id);
});

test('a newer snapshot (refresh) confirms the hosts and releases the reservation', async () => {
  resetLoginCounters();
  run("UPDATE labs SET status = 'removed' WHERE id = 40");
  makeLab(41, 2, 4);
  const alice = (await login('alice', NEW_PW)).cookie!;
  const r = await app.inject({ method: 'POST', url: '/api/labs/41/day2', headers: { ...H, cookie: alice }, payload: { action: 'AddCluster', values: { VIDomain: 'Management' } } });
  assert.equal(r.statusCode, 200, r.body);
  await cancelJob(r.json().job.id);
  assert.equal(labHostBudget(getLab(41)!).unconfirmed, true);
  run("UPDATE jobs SET status = 'succeeded' WHERE lab_id = 41 AND type = 'lab-refresh'");
  // The refresh found 2 of the 3 hosts were created: that becomes the count.
  run(
    'UPDATE labs SET nodes = ?, snapshot_at = ? WHERE id = 41',
    JSON.stringify(['01a', '02a', '03a', '04a', '05a', '06a'].map((n) => ({ name: `x-esx-${n}`, type: 'ESX_Host' }))),
    new Date(Date.now() + 1000).toISOString(),
  );
  const b = labHostBudget(getLab(41)!);
  assert.deepEqual([b.count, b.unconfirmed], [6, false]);
});

// --------------------------------------------------------------------------- SSO issuer

const rules = { adminGroups: [], userGroups: [], autoProvision: true };

test('SSO: the same subject from a different issuer is not the same account', () => {
  const u = upsertSsoUser({ source: 'oidc', issuer: 'https://idp-one.test/', externalId: 'sub-1', username: 'dana', groups: [] }, rules);
  assert.equal(get<{ sso_issuer: string }>('SELECT sso_issuer FROM users WHERE id = ?', u.id)!.sso_issuer, 'https://idp-one.test/');
  // Case and trailing slash don't matter.
  assert.equal(upsertSsoUser({ source: 'oidc', issuer: 'HTTPS://IDP-ONE.TEST', externalId: 'sub-1', username: 'dana', groups: [] }, rules).id, u.id);
  assert.throws(() => upsertSsoUser({ source: 'oidc', issuer: 'https://idp-two.test', externalId: 'sub-1', username: 'someone', groups: [] }, rules), /different identity provider/);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE action = 'auth.sso.issuer-conflict'")!.n, 1);
});

test('SSO: links made before issuers were recorded adopt the next issuer; unlink clears it', async () => {
  resetLoginCounters();
  run("INSERT INTO users (id, username, role, auth_source, external_id) VALUES (60, 'legacy', 'user', 'saml', 'nameid-legacy')");
  assert.equal(upsertSsoUser({ source: 'saml', issuer: 'urn:idp:one', externalId: 'nameid-legacy', username: 'legacy', groups: [] }, rules).id, 60);
  assert.equal(get<{ sso_issuer: string }>('SELECT sso_issuer FROM users WHERE id = 60')!.sso_issuer, 'urn:idp:one');
  assert.throws(() => upsertSsoUser({ source: 'saml', issuer: 'urn:idp:two', externalId: 'nameid-legacy', username: 'legacy', groups: [] }, rules));
  const admin = (await login('admin')).cookie!;
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/users/60/unlink-sso', headers: { ...H, cookie: admin } })).statusCode, 200);
  assert.equal(get<{ sso_issuer: string | null }>('SELECT sso_issuer FROM users WHERE id = 60')!.sso_issuer, null);
  assert.equal(upsertSsoUser({ source: 'saml', issuer: 'urn:idp:two', externalId: 'nameid-new', username: 'legacy', groups: [] }, rules).id, 60);
});

// --------------------------------------------------------------------------- SAML start cap

test('SAML: unauthenticated starts cannot grow the request cache without bound', async () => {
  const future = Date.now() + 600_000;
  run('BEGIN');
  for (let i = 0; i < SAML_CACHE_MAX; i++) run('INSERT INTO saml_cache (key, value, expires_at) VALUES (?, ?, ?)', `cap-${i}`, 'x', future);
  run('COMMIT');
  await assert.rejects(samlStart(), (err: Error & { status?: number; statusCode?: number }) => /Too many sign-ins/.test(err.message));
  run("DELETE FROM saml_cache WHERE key LIKE 'cap-%'");
});
