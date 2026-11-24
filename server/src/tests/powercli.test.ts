/** PowerCLI is downloaded on first start: vCenter tasks wait for it with a clear reason. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-pcli-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_LOG_LEVEL = 'silent';
const { assertPowerCli, powerCliStatus } = await import('../powercli.js');
const status = (o: object) => fs.writeFileSync(path.join(tmp, 'powershell', 'powercli.json'), JSON.stringify(o));

test('no module folder configured (development host): assumed installed', () => {
  delete process.env.HP_PS_MODULES;
  assert.equal(powerCliStatus(), null);
  assertPowerCli();
});

test('installing, failed, ready', () => {
  process.env.HP_PS_MODULES = path.join(tmp, 'powershell', 'Modules');
  fs.mkdirSync(process.env.HP_PS_MODULES, { recursive: true });
  assert.throws(assertPowerCli, /still being downloaded/, 'no status yet');
  status({ state: 'failed', version: '13.5.1', message: 'Unable to resolve package source.', at: 'now' });
  assert.throws(assertPowerCli, /could not be downloaded.*Unable to resolve/);
  status({ state: 'ready', version: '13.5.1', message: '', at: 'now' });
  assertPowerCli();
});
