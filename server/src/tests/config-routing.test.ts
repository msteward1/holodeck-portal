/** Labs only go to Holorouters that serve their configuration (capacity profile), and the deploy page knows which. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-cfgroute-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_ETC_DIR = path.join(tmp, 'etc');
process.env.HP_SYSTEMD_RUN = '0';
process.env.HP_LOG_LEVEL = 'silent';

const { run, get } = await import('../db.js');
const { pickRouter, routerServesConfig, eligibleRouters } = await import('../holorouters.js');

run("INSERT INTO users (id, username, role, first_name, last_name) VALUES (1, 'admin', 'admin', 'A', 'D')");
run("INSERT INTO configs (id, config_id, name, entitle_all) VALUES (1, 'vcfa', 'vCenter', 1), (2, 'esxa', 'Nested ESXi', 1), (3, 'other', 'Other', 1)");
run(`INSERT INTO capacity_profiles (id, name, config_id, datastore, mgmt_network, trunk_a, trunk_b) VALUES
     (1, 'vc', 1, 'ds', 'mgmt', 'ta', 'tb'), (2, 'esx', 2, 'ds', 'mgmt', 'ta', 'tb')`);
// Slot 1 is a vCenter router, slot 2 the only Nested ESXi router, slot 3 has no profile (uses the config's placement).
run("INSERT INTO holorouters (id, name, address, mgmt_ip, slot, origin, status, profile_id) VALUES (1, 'hr1', '192.0.2.1', '192.0.2.1', 1, 'imported', 'ready', 1)");
run("INSERT INTO holorouters (id, name, address, mgmt_ip, slot, origin, status, profile_id) VALUES (2, 'hr5', '192.0.2.5', '192.0.2.5', 2, 'imported', 'ready', 2)");
const admin = get<import('../labs.js').UserRow>('SELECT * FROM users WHERE id = 1')!;
const R = (id: number) => get<import('../holorouters.js').RouterRow>('SELECT * FROM holorouters WHERE id = ?', id)!;

test('a router with a profile serves only its configuration; one without serves any', () => {
  assert.equal(routerServesConfig(R(1), 1), true);
  assert.equal(routerServesConfig(R(1), 2), false);
  run("INSERT INTO holorouters (id, name, address, mgmt_ip, slot, origin, status) VALUES (3, 'hr3', '192.0.2.3', '192.0.2.3', 3, 'imported', 'ready')");
  assert.equal(routerServesConfig(R(3), 2), true);
  run('DELETE FROM holorouters WHERE id = 3');
});

test('Nested ESXi goes to its own router, never to the lowest free vCenter router', () => {
  assert.equal(pickRouter(admin, undefined, undefined, 2)?.name, 'hr5');
  assert.equal(pickRouter(admin, undefined, undefined, 1)?.name, 'hr1');
  assert.equal(pickRouter(admin, 1, undefined, 2), null, 'pinning a vCenter router for a Nested ESXi lab');
  assert.equal(pickRouter(admin, undefined, undefined, 3), null, 'nothing serves "other"');
  assert.deepEqual(eligibleRouters(admin, undefined, 2).map((r) => r.name), ['hr5']);
});

test('when the only router of a configuration has a lab, there is no router for it', () => {
  run(
    `INSERT INTO labs (instance_id, name, owner_id, config_id, slot, sites, version, mode, status, lease_expires_at, holorouter_id)
     VALUES ('n1', 'L', 1, 2, 2, '[]', '9.1.0.0', 'VVF', 'ready', '2099-01-01T00:00:00Z', 2)`,
  );
  assert.equal(pickRouter(admin, undefined, undefined, 2), null);
  assert.equal(pickRouter(admin, undefined, undefined, 1)?.name, 'hr1');
});
