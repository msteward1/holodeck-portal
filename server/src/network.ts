import { all } from './db.js';
import type { Settings } from './settings.js';

/** Holodeck consumes ~30 consecutive VLAN IDs per site starting at VLANRangeStart. */
export const VLANS_PER_SITE = 32;

export interface SiteAllocation {
  site: 'a' | 'b';
  cidr: string;
  vlanStart: number;
  vlanEnd: number;
  /** True when the /20 is held for future dual-site support and not deployed. */
  reserved: boolean;
}

export interface SlotAllocation {
  slot: number;
  sites: SiteAllocation[];
}

// ---------------------------------------------------------------------------
// Addresses and VLAN lists
// ---------------------------------------------------------------------------

function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export interface Range {
  from: number;
  to: number;
}

/** "192.0.2.0/24" or "192.0.2.5" -> inclusive address range, or null if malformed. */
export function cidrRange(cidr: string): Range | null {
  const [ip, len = '32'] = cidr.trim().split('/');
  const base = ipToInt(ip);
  const bits = Number(len);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const from = Math.floor(base / size) * size;
  return { from, to: from + size - 1 };
}

const overlaps = (a: Range, b: Range) => a.from <= b.to && b.from <= a.to;

/** "1210-1218, 1500" -> VLAN ranges; throws on malformed entries. */
export function parseVlanList(text: string): Range[] {
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((part) => {
      const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part);
      const from = m ? Number(m[1]) : NaN;
      const to = m ? Number(m[2] ?? m[1]) : NaN;
      if (!m || from < 1 || to > 4094 || from > to) throw new Error(`'${part}' is not a VLAN or VLAN range (1-4094)`);
      return { from, to };
    });
}

/** "192.0.2.0/24, 198.51.100.0/24" -> CIDRs; throws on malformed entries. */
export function parseNetworkList(text: string): { cidr: string; range: Range }[] {
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((cidr) => {
      const range = cidrRange(cidr);
      if (!range) throw new Error(`'${cidr}' is not an IPv4 network (a.b.c.d/nn) or address`);
      return { cidr, range };
    });
}

/** Networks that must never be used for labs but aren't in the settings: management networks the portal can see. */
export interface KnownNetwork {
  cidr: string;
  label: string;
}

/** Why a candidate slot's networks can't be used, or [] if they can. */
function groupConflicts(net: Settings['network'], sites: SiteAllocation[], extra: KnownNetwork[] = []): string[] {
  const vlans = safe(() => parseVlanList(net.blockedVlans ?? ''), []);
  const nets = safe(() => parseNetworkList(net.blockedNetworks ?? ''), []);
  const out: string[] = [];
  for (const site of sites) {
    const r = cidrRange(site.cidr)!;
    for (const v of vlans) if (v.from <= site.vlanEnd && site.vlanStart <= v.to) out.push(`VLANs ${site.vlanStart}-${site.vlanEnd} include blocked VLAN${v.from === v.to ? ` ${v.from}` : `s ${v.from}-${v.to}`}`);
    for (const n of nets) if (overlaps(r, n.range)) out.push(`${site.cidr} overlaps blocked network ${n.cidr}`);
    for (const k of extra) {
      const kr = cidrRange(k.cidr);
      if (kr && overlaps(r, kr)) out.push(`${site.cidr} overlaps ${k.label} ${k.cidr}`);
    }
  }
  return out;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function groupSites(net: Settings['network'], group: number): SiteAllocation[] {
  const sites: SiteAllocation[] = [];
  for (let i = 0; i < net.sitesPerLab; i++) {
    const octet = net.secondOctetStart + group * net.sitesPerLab + i;
    const vlanStart = octet * net.vlanMultiplier;
    sites.push({
      site: i === 0 ? 'a' : 'b',
      cidr: `${net.firstOctet}.${octet}.0.0/20`,
      vlanStart,
      vlanEnd: vlanStart + VLANS_PER_SITE - 1,
      reserved: i > 0,
    });
  }
  return sites;
}

/** Candidate groups of `sitesPerLab` /20s in the pool, with what (if anything) rules each out. */
export function poolGroups(net: Settings['network']): { sites: SiteAllocation[]; skipped: string[] }[] {
  const groups = Math.max(0, Math.floor((net.secondOctetEnd - net.secondOctetStart + 1) / net.sitesPerLab));
  return Array.from({ length: groups }, (_, g) => {
    const sites = groupSites(net, g);
    return { sites, skipped: groupConflicts(net, sites) };
  });
}

/**
 * Slot n (1-based) reserves `sitesPerLab` consecutive /20s: the n-th group in the pool that touches no blocked VLAN
 * or network (those groups are skipped). Default pool 10.1–10.10 gives 5 slots: slot 1 = 10.1.0.0/20 (VLAN 100) +
 * 10.2.0.0/20 (VLAN 200), …
 *
 * This is the only place that knows the CIDR/VLAN formula.
 */
export function describeSlot(net: Settings['network'], slot: number): SlotAllocation {
  const usable = poolGroups(net).filter((g) => !g.skipped.length);
  const sites = usable[slot - 1]?.sites ?? groupSites(net, slot - 1);
  return { slot, sites };
}

export function slotCount(net: Settings['network']): number {
  return poolGroups(net).filter((g) => !g.skipped.length).length;
}

/** Problems with this slot for a lab: blocked items, or management networks the portal sees (address guard). */
export function slotConflicts(net: Settings['network'], slot: number, known: KnownNetwork[] = []): string[] {
  if (slot < 1 || slot > slotCount(net)) return [`slot ${slot} is outside the network pool`];
  return groupConflicts(net, describeSlot(net, slot).sites, known);
}

export function validatePool(net: Settings['network'], known: KnownNetwork[] = []): string[] {
  const problems: string[] = [];
  try {
    parseVlanList(net.blockedVlans ?? '');
  } catch (err) {
    problems.push(`Blocked VLANs: ${(err as Error).message}.`);
  }
  try {
    parseNetworkList(net.blockedNetworks ?? '');
  } catch (err) {
    problems.push(`Blocked networks: ${(err as Error).message}.`);
  }
  const count = slotCount(net);
  if (count === 0) problems.push('The pool is too small: it has no usable slot (each lab needs two /20 networks clear of blocked VLANs and networks).');
  // Address guard: a usable slot must not overlap a management network the portal can see.
  for (let s = 1; s <= count; s++) {
    for (const c of groupConflicts({ ...net, blockedVlans: '', blockedNetworks: '' }, describeSlot(net, s).sites, known)) {
      problems.push(`Slot ${s}: ${c}. Add that network to Blocked networks so the pool skips it.`);
    }
  }
  for (let s = 1; s <= count; s++) {
    for (const site of describeSlot(net, s).sites) {
      if (site.vlanEnd > 4094) problems.push(`${site.cidr} would use VLANs ${site.vlanStart}-${site.vlanEnd}, beyond 4094.`);
    }
  }
  if (net.vlanMultiplier < VLANS_PER_SITE) {
    problems.push(`VLAN multiplier ${net.vlanMultiplier} is smaller than the ${VLANS_PER_SITE} VLANs a site uses; ranges would overlap.`);
  }
  return problems;
}

export function usedSlots(): Set<number> {
  return new Set(all<{ slot: number }>("SELECT slot FROM labs WHERE status <> 'removed'").map((r) => r.slot));
}

/** Lowest free slot, or null if the pool is exhausted. Call inside a transaction. */
export function nextFreeSlot(net: Settings['network']): number | null {
  const used = usedSlots();
  for (let s = 1; s <= slotCount(net); s++) if (!used.has(s)) return s;
  return null;
}

export function poolOverview(net: Settings['network']) {
  const rows = all<{ slot: number; id: number; name: string; instance_id: string; status: string }>(
    "SELECT slot, id, name, instance_id, status FROM labs WHERE status <> 'removed'",
  );
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  // Each slot belongs to the Holorouter assigned to it; a slot without one can't host a lab.
  const routers = new Map(
    all<{ slot: number; id: number; name: string; status: string }>('SELECT slot, id, name, status FROM holorouters').map((r) => [r.slot, r]),
  );
  return Array.from({ length: slotCount(net) }, (_, i) => {
    const alloc = describeSlot(net, i + 1);
    const lab = bySlot.get(i + 1);
    const router = routers.get(i + 1);
    return {
      ...alloc,
      lab: lab ? { id: lab.id, name: lab.name, instanceId: lab.instance_id, status: lab.status } : null,
      holorouter: router ? { id: router.id, name: router.name, status: router.status } : null,
    };
  });
}
