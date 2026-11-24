/** Dashboard notices: administrators only, while new routers default to portal-only; "don't show again" sticks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-notice-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_ETC_DIR = path.join(tmp, 'etc');
process.env.HP_LOG_LEVEL = 'silent';
process.env.HP_WEB_DIST = path.join(tmp, 'no-web');
fs.mkdirSync(process.env.HP_ETC_DIR, { recursive: true });

const { run } = await import('../db.js');
const { hashPassword } = await import('../crypto.js');
const { buildApp } = await import('../app.js');
const { getSettings, setSecret, updateSettings } = await import('../settings.js');
const { resetLoginCounters } = await import('../auth/session.js');
const app = await buildApp();
const H = { 'x-holoportal': '1' };
const PW = 'correct horse battery';
for (const [id, name, role] of [[1, 'admin', 'admin'], [2, 'alice', 'user']] as const) {
  run('INSERT INTO users (id, username, role, first_name, last_name, password_hash) VALUES (?, ?, ?, ?, ?, ?)', id, name, role, name, 'T', await hashPassword(PW));
}
async function login(username: string) {
  resetLoginCounters();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: H, payload: { username, password: PW } });
  const c = ([] as string[]).concat(res.headers['set-cookie'] as string[]).find((x) => x.startsWith('hp_session='))!;
  return c.split(';')[0];
}
const notices = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie } })).json().notices as { id: string; warning?: string }[];

test('new installations: gateway on, portal-only, and administrators are told (with the webtop password reminder)', async () => {
  assert.deepEqual(getSettings().holorouters.webtopGateway, { enabled: true, defaultMode: 'portal-only' });
  const admin = await login('admin');
  const n = await notices(admin);
  assert.equal(n[0]?.id, 'webtop-gateway-default');
  assert.match(n[0].warning ?? '', /webtop password/);
  setSecret('webtop.password', 'x');
  assert.equal((await notices(admin))[0].warning, undefined);
  assert.deepEqual(await notices(await login('alice')), [], 'users never see it');
});

test("don't show again is kept on the account; another default hides the notice", async () => {
  const admin = await login('admin');
  const r = await app.inject({ method: 'POST', url: '/api/notices/webtop-gateway-default/dismiss', headers: { ...H, cookie: admin } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(await notices(await login('admin')), []);
  run('UPDATE users SET dismissed_notices = NULL WHERE id = 1');
  updateSettings('holorouters', { ...getSettings().holorouters, webtopGateway: { enabled: true, defaultMode: 'portal' } });
  assert.deepEqual(await notices(admin), []);
  assert.equal((await app.inject({ method: 'POST', url: '/api/notices/other/dismiss', headers: { ...H, cookie: admin } })).statusCode, 400);
});
