import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir and a fake job runner: jobs "succeed" without touching Holodeck.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-lease-'));
const psDir = path.join(tmp, 'ps');
fs.mkdirSync(psDir);
fs.writeFileSync(
  path.join(psDir, 'run-job.sh'),
  '#!/bin/bash\ncd "$1"; echo \'{"power":{"state":"off"}}\' > result.json; echo fake >> output.log; echo 0 > exitcode\n',
  { mode: 0o755 },
);
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_PS_DIR = psDir;
process.env.HP_SYSTEMD_RUN = '0';

const { run, get, all } = await import('../db.js');
const { checkLeases } = await import('../lease.js');
const { extendLease, getLab, removeLab } = await import('../labs.js');
const { startJobLoop, stopJobLoop } = await import('../holodeck/jobs.js');
const { updateSettings, getSettings } = await import('../settings.js');

run("INSERT INTO users (id, username, role, first_name, last_name) VALUES (1, 'admin', 'admin', 'A', 'D'), (2, 'u', 'user', 'U', 'S')");
run("INSERT INTO configs (id, config_id, name) VALUES (1, 'test', 'Test')");

function makeLab(id: number, hoursLeft: number, status = 'ready', power = 'on') {
  run(
    `INSERT INTO labs (id, instance_id, name, owner_id, config_id, slot, sites, version, mode, status, power_state, lease_expires_at)
     VALUES (?, ?, ?, 2, 1, ?, '[{"site":"a","cidr":"10.1.0.0/20","vlanStart":100,"vlanEnd":131,"reserved":false}]', '9.1.0.0', 'VVF', ?, ?, ?)`,
    id,
    `lab${id}`,
    `Lab ${id}`,
    id,
    status,
    power,
    new Date(Date.now() + hoursLeft * 3600_000).toISOString(),
  );
}

const notes = (labId: number) => all<{ title: string; user_id: number }>('SELECT title, user_id FROM notifications WHERE lab_id = ? ORDER BY id', labId);
const user = () => get<import('../labs.js').UserRow>('SELECT * FROM users WHERE id = 2')!;

test('two warnings at the configured lead times, once each', () => {
  updateSettings('lease', { ...getSettings().lease, firstWarning: { value: 1, unit: 'days' }, secondWarning: { value: 2, unit: 'hours' } });
  makeLab(1, 20); // inside the 1-day window only
  checkLeases();
  checkLeases();
  assert.equal(getLab(1)!.warned_level, 1);
  assert.equal(notes(1).length, 1);
  assert.match(notes(1)[0].title, /lease ends in 20 hours/);

  run('UPDATE labs SET lease_expires_at = ? WHERE id = 1', new Date(Date.now() + 90 * 60_000).toISOString());
  checkLeases();
  assert.equal(getLab(1)!.warned_level, 2);
  assert.equal(notes(1).length, 2);
});

test('a short lease inside both windows warns once', () => {
  makeLab(2, 1);
  checkLeases();
  assert.equal(getLab(2)!.warned_level, 2);
  assert.equal(notes(2).length, 1);
});

test('expiry powers the lab off (never removes it) and tells owner and admins', async () => {
  makeLab(3, -0.01);
  startJobLoop();
  checkLeases();
  const lab = getLab(3)!;
  assert.equal(lab.lease_expired, 1);
  assert.equal(lab.status, 'ready');
  const job = get<{ type: string; params: string }>('SELECT type, params FROM jobs WHERE lab_id = 3');
  assert.equal(job?.type, 'lab-power');
  assert.match(job!.params, /"action":"stop"/);
  assert.deepEqual(
    notes(3).map((n) => n.user_id).sort(),
    [1, 2],
  );
  // The fake runner finishes the job; the lab ends up powered off.
  for (let i = 0; i < 50 && getLab(3)!.power_state !== 'off'; i++) await new Promise((r) => setTimeout(r, 100));
  stopJobLoop();
  assert.equal(getLab(3)!.power_state, 'off');
  assert.equal(get<{ status: string }>('SELECT status FROM jobs WHERE lab_id = 3')!.status, 'succeeded');
});

test('users cannot renew expired leases or exceed the maximum; extending resets warnings', () => {
  assert.throws(() => extendLease(user(), getLab(3)!, 24), /administrator/);
  assert.throws(() => extendLease(user(), getLab(1)!, 10_000), /cannot run more than/);
  const lab = extendLease(user(), getLab(1)!, 48);
  assert.equal(lab.warned_level, 0);
  const admin = get<import('../labs.js').UserRow>('SELECT * FROM users WHERE id = 1')!;
  const renewed = extendLease(admin, getLab(3)!, 24);
  assert.equal(renewed.lease_expired, 0);
});

test('removing a lab never resets the Holorouter', () => {
  makeLab(4, 24);
  removeLab(user(), getLab(4)!);
  const job = get<{ id: string }>("SELECT id FROM jobs WHERE lab_id = 4 AND type = 'lab-remove'")!;
  const steps = fs.readFileSync(path.join(process.env.HP_DATA_DIR!, 'jobs', job.id, 'job.json'), 'utf8');
  assert.match(steps, /Remove-HoloDeckInstance/);
  assert.doesNotMatch(steps, /ResetHoloRouter|Reset-HoloRouter/);
  // Holodeck leaves the FQDN-named installer VM behind; the portal deletes it before verifying.
  assert.ok(steps.indexOf('HP-RemoveLeftoverVMs') > steps.indexOf('Remove-HoloDeckInstance'));
  assert.ok(steps.indexOf('HP-AssertRemoved') > steps.indexOf('HP-RemoveLeftoverVMs'));
});
