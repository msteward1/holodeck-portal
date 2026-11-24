/** Network pool: blocked VLANs/networks are skipped, and the address guard (management networks). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-net-'));
process.env.HP_DATA_DIR = path.join(tmp, 'data');
process.env.HP_HOLODECK_ROOT = path.join(tmp, 'holo');
process.env.HP_SYSTEMD_RUN = '0';

const { describeSlot, slotCount, slotConflicts, validatePool, poolGroups, parseVlanList, parseNetworkList, cidrRange } = await import('../network.js');

const base = { firstOctet: 10, secondOctetStart: 1, secondOctetEnd: 16, sitesPerLab: 2 as const, vlanMultiplier: 100, dnsDomainTemplate: 'lab{instance}.vcf.lab', blockedVlans: '', blockedNetworks: '' };
const cidrs = (net: typeof base) => Array.from({ length: slotCount(net) }, (_, i) => describeSlot(net, i + 1).sites[0].cidr);

test('parsing', () => {
  assert.deepEqual(parseVlanList('1110-1118, 1200'), [{ from: 1110, to: 1118 }, { from: 1200, to: 1200 }]);
  assert.throws(() => parseVlanList('1118-1110'));
  assert.throws(() => parseVlanList('5000'));
  assert.equal(parseNetworkList('10.11.4.0/24').length, 1);
  assert.throws(() => parseNetworkList('10.11.4/24'));
  assert.deepEqual(cidrRange('10.11.4.77/24'), cidrRange('10.11.4.0/24'));
});

test('no blocks: the same slots as before', () => {
  assert.deepEqual(cidrs(base), ['10.1.0.0/20', '10.3.0.0/20', '10.5.0.0/20', '10.7.0.0/20', '10.9.0.0/20', '10.11.0.0/20', '10.13.0.0/20', '10.15.0.0/20']);
});

test('blocked VLANs 1110-1118 skip 10.11/10.12; slots 1-5 keep their networks', () => {
  const net = { ...base, blockedVlans: '1110-1118' };
  assert.deepEqual(cidrs(net), ['10.1.0.0/20', '10.3.0.0/20', '10.5.0.0/20', '10.7.0.0/20', '10.9.0.0/20', '10.13.0.0/20', '10.15.0.0/20']);
  assert.equal(describeSlot(net, 6).sites[0].vlanStart, 1300);
  const skipped = poolGroups(net).filter((g) => g.skipped.length);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].skipped[0], /1100-1131 include blocked VLANs 1110-1118/);
  // Blocking the networks instead has the same effect.
  assert.deepEqual(cidrs({ ...base, blockedNetworks: '10.11.4.0/24' }), cidrs(net));
});

test('address guard: a slot overlapping a management network is reported, and blocking it clears the problem', () => {
  const known = [{ cidr: '10.11.4.10/24', label: "the portal's management network" }, { cidr: '10.11.4.20/32', label: "router-b's management address" }];
  const problems = validatePool(base, known);
  assert.ok(problems.some((p) => /Slot 6: 10\.11\.0\.0\/20 overlaps the portal's management network/.test(p)));
  assert.match(slotConflicts(base, 6, known).join(' '), /router-b's management address/);
  assert.deepEqual(slotConflicts(base, 5, known), []);
  assert.deepEqual(validatePool({ ...base, blockedNetworks: '10.11.4.0/24' }, known), []);
  assert.deepEqual(slotConflicts(base, 99, known), ['slot 99 is outside the network pool']);
});

test('pool with nothing usable', () => {
  assert.match(validatePool({ ...base, secondOctetStart: 11, secondOctetEnd: 12, blockedVlans: '1110' }).join(' '), /no usable slot/);
});
