/**
 * Webtop gateway: modes, the nginx authorize answer, password hiding, relays and the router firewall.
 * In-process with app.inject() against a throwaway database; no systemd, SSH or nginx is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-gw-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_ETC_DIR = path.join(tmp, 'etc');
process.env.HP_HOLODECK_ROOT = path.join(tmp, 'holo');
process.env.HP_PUBLIC_URL = 'https://portal.test';
process.env.HP_SYSTEMD_RUN = '0';
process.env.HP_LOG_LEVEL = 'silent';
process.env.HP_WEB_DIST = path.join(tmp, 'no-web');
fs.mkdirSync(process.env.HP_ETC_DIR, { recursive: true });

const { run, get } = await import('../db.js');
const { hashPassword } = await import('../crypto.js');
const { buildApp } = await import('../app.js');
const { updateSettings, setSecret, getSettings } = await import('../settings.js');
const { resetLoginCounters } = await import('../auth/session.js');
const { getRouter } = await import('../holorouters.js');
const { getLab, labWebtop } = await import('../labs.js');
const gw = await import('../webtop-gateway.js');

const app = await buildApp();
const H = { 'x-holoportal': '1' };
const PW = 'correct horse battery';
const TOKEN = 'f'.repeat(64);

run("INSERT INTO configs (id, config_id, name, entitle_all) VALUES (1, 'test', 'Test', 1)");
for (const [id, name, role] of [
  [1, 'admin', 'admin'],
  [2, 'alice', 'user'],
  [3, 'bob', 'user'],
] as const) {
  run('INSERT INTO users (id, username, role, first_name, last_name, password_hash) VALUES (?, ?, ?, ?, ?, ?)', id, name, role, name, 'T', await hashPassword(PW));
}
if (!get('SELECT 1 FROM holorouters WHERE id = 1')) {
  run("INSERT INTO holorouters (id, name, address, mgmt_ip, slot, origin, status) VALUES (1, 'hr1', '127.0.0.1', '127.0.0.1', 1, 'imported', 'ready')"); // also hosts the portal
}
run("INSERT INTO holorouters (id, name, address, mgmt_ip, slot, origin, status, inspection) VALUES (2, 'hr2', '192.0.2.2', '192.0.2.2', 2, 'deployed', 'ready', '{}')");
run(
  `INSERT INTO labs (id, instance_id, name, owner_id, config_id, slot, sites, version, mode, status, power_state, lease_expires_at, holorouter_id)
   VALUES (1, 'a2', 'Lab', 2, 1, 2, '[]', '9.1.0.0', 'VVF', 'ready', 'on', ?, 2)`,
  new Date(Date.now() + 86400_000).toISOString(),
);
setSecret('webtop.password', 'webtop-secret');

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const c = list.find((x) => x.startsWith(`${name}=`) && !x.startsWith(`${name}=;`));
  return c ? c.split(';')[0] : null;
}
async function login(username: string) {
  resetLoginCounters();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { username, password: PW } });
  return cookieFrom(res, 'hp_session')!;
}
const authorize = (cookie: string | null, port = 8442, token: string | null = TOKEN) =>
  app.inject({
    method: 'GET',
    url: '/api/webtop/authorize',
    headers: { ...(cookie ? { cookie } : {}), ...(token ? { 'x-hp-gateway-token': token } : {}), 'x-hp-gateway-port': String(port) },
  });
const setGateway = (enabled: boolean, defaultMode: 'direct' | 'portal' | 'portal-only' = 'direct') =>
  updateSettings('holorouters', { ...getSettings().holorouters, webtopGateway: { enabled, defaultMode } });

test('off by default: every router is direct and nothing changes', async () => {
  assert.equal(gw.effectiveWebtopMode(getRouter(2)!), 'direct');
  const w = labWebtop(getLab(1)!)!;
  assert.equal(w.url, 'http://192.0.2.2:30000/');
  assert.equal(w.password, 'webtop-secret');
  assert.equal(w.viaPortal, false);
});

test('enabling the gateway needs it installed (token); modes then follow default and per-router choice', async () => {
  const admin = await login('admin');
  const put = (body: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/admin/settings/holorouters', headers: { ...H, cookie: admin }, payload: body });
  const r = await put({ ...getSettings().holorouters, webtopGateway: { enabled: true, defaultMode: 'portal' } });
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.json().error, /not set up/);
  fs.writeFileSync(path.join(process.env.HP_ETC_DIR!, 'webtop-gateway.token'), TOKEN);
  const ok = await put({ ...getSettings().holorouters, webtopGateway: { enabled: true, defaultMode: 'portal' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(gw.effectiveWebtopMode(getRouter(2)!), 'portal');
  // A router that also hosts the portal can't be portal-only (its 443 is the portal), neither by default nor by choice.
  setGateway(true, 'portal-only');
  assert.equal(gw.effectiveWebtopMode(getRouter(1)!), 'portal');
  assert.equal(gw.effectiveWebtopMode(getRouter(2)!), 'portal-only');
  const p = await app.inject({ method: 'PATCH', url: '/api/admin/holorouters/1', headers: { ...H, cookie: admin }, payload: { webtopMode: 'portal-only' } });
  assert.equal(p.statusCode, 400);
  const d = await app.inject({ method: 'PATCH', url: '/api/admin/holorouters/2', headers: { ...H, cookie: admin }, payload: { webtopMode: 'direct' } });
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(gw.effectiveWebtopMode(getRouter(2)!), 'direct');
  run('UPDATE holorouters SET webtop_mode = NULL WHERE id = 2');
  setGateway(true, 'portal');
});

test('through the portal: the lab shows a per-router HTTPS port and no password', () => {
  const w = labWebtop(getLab(1)!)!;
  assert.equal(w.url, 'https://portal.test:8442/');
  assert.equal(w.viaPortal, true);
  assert.equal(w.password, null);
  assert.equal(w.username, null);
});

test('authorize: only nginx (token), only signed-in owners and admins, only gateway routers', async () => {
  const alice = await login('alice');
  const bob = await login('bob');
  const admin = await login('admin');
  assert.equal((await authorize(alice, 8442, null)).statusCode, 403);
  assert.equal((await authorize(alice, 8442, 'x'.repeat(64))).statusCode, 403);
  assert.equal((await authorize(null)).statusCode, 401);
  assert.equal((await authorize(bob)).statusCode, 403);
  const ok = await authorize(alice);
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers['x-webtop-upstream-port'], '31002');
  assert.equal(ok.headers['x-webtop-authorization'], `Basic ${Buffer.from('admin:webtop-secret').toString('base64')}`);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal((await authorize(admin)).statusCode, 204);
  // Every router goes through its relay (31000 + slot); a slot with no router, or outside the range, is refused.
  assert.equal((await authorize(admin, 8441)).headers['x-webtop-upstream-port'], '31001');
  assert.equal((await authorize(admin, 8445)).statusCode, 403);
  assert.equal((await authorize(admin, 8440)).statusCode, 403);
  assert.equal((await authorize(admin, 9000)).statusCode, 403);
  // A direct-mode router is not served by the gateway.
  run("UPDATE holorouters SET webtop_mode = 'direct' WHERE id = 2");
  assert.equal((await authorize(admin)).statusCode, 403);
  run('UPDATE holorouters SET webtop_mode = NULL WHERE id = 2');
});

test('access follows the lab: transfer and removal end the former owner\'s access', async () => {
  const alice = await login('alice');
  const bob = await login('bob');
  const admin = await login('admin');
  const t = await app.inject({ method: 'PATCH', url: '/api/labs/1', headers: { ...H, cookie: admin }, payload: { ownerId: 3 } });
  assert.equal(t.statusCode, 200, t.body);
  assert.equal((await authorize(alice)).statusCode, 403);
  assert.equal((await authorize(bob)).statusCode, 204);
  run("UPDATE labs SET status = 'removed' WHERE id = 1");
  assert.equal((await authorize(bob)).statusCode, 403);
  assert.equal((await authorize(admin)).statusCode, 204);
});

test('relays: one env file per gateway secondary, removed again in direct mode', async () => {
  const dir = path.join(process.env.HP_DATA_DIR!, 'webtop');
  await gw.syncRelays([getRouter(1)!, getRouter(2)!]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['1.env', '2.env']);
  assert.match(fs.readFileSync(path.join(dir, '2.env'), 'utf8'), /^ADDRESS=192\.0\.2\.2\nLOCAL_PORT=31002\nSSH_DIR=/);
  assert.equal(fs.statSync(path.join(dir, '2.env')).mode & 0o777, 0o600);
  setGateway(false);
  await gw.syncRelays([getRouter(1)!, getRouter(2)!]);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('router firewall commands only touch the portal\'s own rule', () => {
  const close = gw.firewallCommand(true);
  const open = gw.firewallCommand(false);
  for (const c of [close, open]) {
    assert.match(c, /-t raw/);
    assert.match(c, /-i eth0 -p tcp -m multiport --dports 80,443,30000,30001 -m comment --comment holodeck-portal-webtop -j DROP/);
  }
  assert.match(close, /-C PREROUTING .* \|\| iptables -t raw -I PREROUTING 1 /);
  assert.match(open, /^while iptables -t raw -D PREROUTING /);
});
