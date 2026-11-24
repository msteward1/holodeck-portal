/** Leases in days (with conversion of hour-based settings), slot-based lab names and Holorouter VM names. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-naming-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_ETC_DIR = path.join(tmp, 'etc');
process.env.HP_SYSTEMD_RUN = '0';
process.env.HP_LOG_LEVEL = 'silent';

const { run } = await import('../db.js');
const { getSettings, updateSettings } = await import('../settings.js');
const { labDnsDomain, slotTag, suggestedInstanceId } = await import('../labs.js');

test('hour-based lease settings convert to days once, rounding up', () => {
  run("INSERT INTO settings (key, value) VALUES ('lease', ?)", JSON.stringify({ defaultHours: 72, maxHours: 337, usersCanExtend: true }));
  const l = getSettings().lease;
  assert.equal(l.defaultDays, 3);
  assert.equal(l.maxDays, 15);
  assert.equal((l as Record<string, unknown>).defaultHours, undefined);
  updateSettings('lease', { ...l, defaultDays: 14, maxDays: 365 });
  assert.equal(getSettings().lease.defaultDays, 14);
  assert.throws(() => updateSettings('lease', { ...getSettings().lease, defaultDays: 30, maxDays: 7 }), /cannot exceed/);
  assert.throws(() => updateSettings('lease', { ...getSettings().lease, maxDays: 366 }));
});

test('fresh installs: 14-day default, 365-day maximum, lab{slot} domains', () => {
  run("DELETE FROM settings WHERE key IN ('lease', 'network')");
  assert.equal(getSettings().lease.defaultDays, 14);
  assert.equal(getSettings().lease.maxDays, 365);
  assert.equal(getSettings().network.dnsDomainTemplate, 'lab{slot}.vcf.lab');
});

test('the old instance-based default template becomes the slot-based one; custom templates are kept', () => {
  run("INSERT INTO settings (key, value) VALUES ('network', ?)", JSON.stringify({ dnsDomainTemplate: 'lab{instance}.vcf.lab' }));
  assert.equal(getSettings().network.dnsDomainTemplate, 'lab{slot}.vcf.lab');
  updateSettings('network', { ...getSettings().network, dnsDomainTemplate: 'r{slot}-{instance}.example.lab' });
  assert.equal(getSettings().network.dnsDomainTemplate, 'r{slot}-{instance}.example.lab');
  assert.throws(() => updateSettings('network', { ...getSettings().network, dnsDomainTemplate: 'lab{site}.vcf.lab' }), /placeholders/);
});

test('domains and instance IDs carry the two-digit slot; a hand-picked clash gets a letter', () => {
  assert.equal(slotTag(6), '06');
  assert.equal(slotTag(12), '12');
  assert.equal(labDnsDomain('lab{slot}.vcf.lab', 's06', 6), 'lab06.vcf.lab');
  assert.equal(labDnsDomain('r{slot}-{instance}.lab', 'x1', 3), 'r03-x1.lab');
  assert.equal(suggestedInstanceId(6), 's06');
  run("INSERT INTO users (id, username, role, first_name, last_name) VALUES (1, 'u', 'user', 'U', 'S')");
  run("INSERT INTO configs (id, config_id, name) VALUES (1, 'test', 'Test')");
  run(
    `INSERT INTO labs (instance_id, name, owner_id, config_id, slot, sites, version, mode, status, lease_expires_at)
     VALUES ('s06', 'L', 1, 1, 2, '[]', '9.1.0.0', 'VVF', 'ready', '2099-01-01T00:00:00Z')`,
  );
  assert.equal(suggestedInstanceId(6), 's06b');
  run("UPDATE labs SET status = 'removed'");
  assert.equal(suggestedInstanceId(6), 's06');
});
