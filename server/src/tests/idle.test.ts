/** Idle labs: warnings before each stage, suspend, shutdown (resuming a suspended lab first), exemptions, router policy. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-idle-'));
const psDir = path.join(tmp, 'ps');
fs.mkdirSync(psDir);
fs.writeFileSync(path.join(psDir, 'run-job.sh'), '#!/bin/bash\ncd "$1"; echo 0 > exitcode\n', { mode: 0o755 });
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_ETC_DIR = path.join(tmp, 'etc');
process.env.HP_PS_DIR = psDir;
process.env.HP_SYSTEMD_RUN = '0';
process.env.HP_LOG_LEVEL = 'silent';

const { run, get, all } = await import('../db.js');
const { updateSettings, getSettings } = await import('../settings.js');
const { checkIdleLabs, idleStatus, touchLab, effectiveIdlePolicy } = await import('../idle.js');
const { getLab } = await import('../labs.js');

const DAY = 86400_000;
run("INSERT INTO users (id, username, role, first_name, last_name, enabled) VALUES (1, 'admin', 'admin', 'A', 'D', 1), (2, 'u', 'user', 'U', 'S', 1)");
run("INSERT INTO configs (id, config_id, name) VALUES (1, 'test', 'Test')");
for (let i = 1; i <= 5; i++) {
  run("INSERT INTO holorouters (id, name, address, mgmt_ip, slot, origin, status) VALUES (?, ?, ?, ?, ?, 'imported', 'ready')", i, `hr${i}`, `192.0.2.${i}`, `192.0.2.${i}`, i);
}

function makeLab(id: number, idleDays: number, power = 'on') {
  const routerId = id;
  run('DELETE FROM jobs WHERE lab_id = ?', id);
  run('DELETE FROM labs WHERE id = ?', id);
  run(
    `INSERT INTO labs (id, instance_id, name, owner_id, config_id, slot, sites, version, mode, status, power_state, lease_expires_at, holorouter_id, last_activity_at)
     VALUES (?, ?, ?, 2, 1, ?, '[]', '9.1.0.0', 'VVF', 'ready', ?, ?, ?, ?)`,
    id, `s0${id}`, `Lab ${id}`, routerId, power, new Date(Date.now() + 100 * DAY).toISOString(), routerId,
    new Date(Date.now() - idleDays * DAY).toISOString(),
  );
}
/** The lab's latest job, with its steps as JSON text (they are in the job directory, not the database). */
const lastJob = (labId: number) => {
  const j = get<{ id: string }>('SELECT id FROM jobs WHERE lab_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', labId);
  if (!j) return undefined;
  const file = path.join(process.env.HP_DATA_DIR!, 'jobs', j.id, 'job.json');
  return { steps: JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).steps) };
};
const titles = (labId: number) => all<{ title: string }>('SELECT title FROM notifications WHERE lab_id = ? ORDER BY id', labId).map((n) => n.title);
const setIdle = (suspend: [boolean, number], shutdown: [boolean, number]) =>
  updateSettings('idle', { suspend: { enabled: suspend[0], days: suspend[1] }, shutdown: { enabled: shutdown[0], days: shutdown[1] } });

test('off by default: nothing happens to idle labs', () => {
  assert.equal(getSettings().idle.suspend.enabled, false);
  assert.equal(getSettings().idle.suspend.days, 7);
  assert.equal(getSettings().idle.shutdown.days, 14);
  makeLab(1, 30);
  checkIdleLabs();
  assert.equal(lastJob(1), undefined);
  assert.equal(idleStatus(getLab(1)!, null).enabled, false);
});

test('a warning a day before suspending, then the suspend; activity resets both', () => {
  setIdle([true, 7], [false, 14]);
  makeLab(1, 6.5);
  checkIdleLabs();
  checkIdleLabs();
  assert.deepEqual(titles(1), ['Lab 1 will be suspended for inactivity']);
  assert.equal(lastJob(1), undefined);
  assert.equal(idleStatus(getLab(1)!, null).next?.action, 'suspend');
  touchLab(1);
  assert.equal(getLab(1)!.idle_warned, 0);
  run('UPDATE labs SET last_activity_at = ? WHERE id = 1', new Date(Date.now() - 7.1 * DAY).toISOString());
  checkIdleLabs();
  assert.match(lastJob(1)!.steps, /HP-SuspendLab/);
  assert.equal(getLab(1)!.power_state, 'suspending');
  assert.ok(titles(1).includes('Lab 1 was suspended for inactivity'));
});

test('a suspended lab is resumed and shut down at the shutdown stage, warned separately', () => {
  setIdle([true, 7], [true, 14]);
  makeLab(2, 13.5, 'suspended');
  checkIdleLabs();
  assert.deepEqual(titles(2), ['Lab 2 will be shut down for inactivity']);
  run('UPDATE labs SET last_activity_at = ? WHERE id = 2', new Date(Date.now() - 14.2 * DAY).toISOString());
  checkIdleLabs();
  const steps = JSON.parse(lastJob(2)!.steps).map((s: { command: string }) => s.command);
  assert.ok(steps.indexOf('Start-HoloDeckInstance') < steps.indexOf('Stop-HoloDeckInstance'), steps.join(','));
  assert.equal(getLab(2)!.power_state, 'stopping');
});

test('shutdown alone (no suspend stage) shuts a running lab down without resuming', () => {
  setIdle([false, 7], [true, 3]);
  makeLab(3, 3.5);
  checkIdleLabs();
  const steps = JSON.parse(lastJob(3)!.steps).map((s: { command: string }) => s.command);
  assert.ok(steps.includes('Stop-HoloDeckInstance'));
  assert.ok(!steps.includes('Start-HoloDeckInstance'));
});

test('exempt labs and opted-out routers are left alone; a router can set its own stages', () => {
  setIdle([true, 7], [true, 14]);
  makeLab(4, 30);
  run('UPDATE labs SET idle_exempt = 1 WHERE id = 4');
  checkIdleLabs();
  assert.equal(lastJob(4), undefined);
  makeLab(5, 30);
  run("UPDATE holorouters SET idle_policy = ? WHERE id = 5", JSON.stringify({ mode: 'off' }));
  checkIdleLabs();
  assert.equal(lastJob(5), undefined);
  run("UPDATE holorouters SET idle_policy = ? WHERE id = 5", JSON.stringify({ mode: 'custom', suspend: { enabled: true, days: 40 }, shutdown: { enabled: false, days: 50 } }));
  const r2 = get<import('../holorouters.js').RouterRow>('SELECT * FROM holorouters WHERE id = 5');
  assert.equal(effectiveIdlePolicy(r2).suspend.days, 40);
  checkIdleLabs();
  assert.equal(lastJob(5), undefined); // 30 days idle < 40
  run('UPDATE labs SET last_activity_at = ? WHERE id = 5', new Date(Date.now() - 41 * DAY).toISOString());
  checkIdleLabs();
  assert.match(lastJob(5)!.steps, /HP-SuspendLab/);
});
