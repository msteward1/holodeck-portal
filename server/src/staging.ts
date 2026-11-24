/**
 * Staged installation files: the ESX installer ISO and the VCF Installer (9.x) or Cloud Builder (5.x)
 * OVA that Holodeck expects in /holodeck-runtime/bin/<version>/. They come from the Broadcom support
 * portal, so an admin places them on any Holorouter; the portal copies them from a router that has a complete
 * copy to the others (see stagingSource).
 *
 * Holodeck's precheck accepts only the file names listed in its bill of materials
 * (/holodeck-runtime/templates/bom.json), so that file decides what counts as staged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { parseJson, run } from './db.js';
import type { RouterRow } from './holorouters.js';

export interface BomEntry {
  esx: string[];
  installer: string[];
  installerKind: 'vcf-installer' | 'cloud-builder';
}
export type Bom = Record<string, BomEntry>;

export interface StagedFile {
  name: string;
  size: number;
}

export interface VersionStaging {
  version: string;
  status: 'ready' | 'incomplete' | 'missing';
  esx: StagedFile | null;
  installer: StagedFile | null;
  installerKind: BomEntry['installerKind'];
  expected: { esx: string[]; installer: string[] };
  /** Files in the folder that Holodeck does not accept for this version. */
  other: StagedFile[];
}

export interface Staging {
  checkedAt: string;
  versions: VersionStaging[];
  error?: string;
}

export function parseBom(text: string | null): Bom {
  const raw = parseJson<Record<string, Record<string, unknown>>>(text, {});
  const bom: Bom = {};
  for (const [version, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.esx)) continue;
    const kind = Array.isArray(entry['cloud-builder']) ? 'cloud-builder' : 'vcf-installer';
    bom[version] = {
      esx: (entry.esx as unknown[]).map(String),
      installer: ((entry[kind] as unknown[] | undefined) ?? []).map(String),
      installerKind: kind,
    };
  }
  return bom;
}

/** Versions in Holodeck's order of appearance (oldest first in bom.json); newest first reads better. */
export function evaluateStaging(bom: Bom, files: Record<string, StagedFile[]>): Staging {
  const versions = Object.entries(bom).map(([version, entry]) => {
    const present = (files[version] ?? []).filter((f) => !f.name.startsWith('.'));
    const esx = present.find((f) => entry.esx.includes(f.name)) ?? null;
    const installer = present.find((f) => entry.installer.includes(f.name)) ?? null;
    const other = present.filter((f) => f !== esx && f !== installer);
    const status: VersionStaging['status'] = esx && installer ? 'ready' : present.length ? 'incomplete' : 'missing';
    return { version, status, esx, installer, installerKind: entry.installerKind, expected: { esx: entry.esx, installer: entry.installer }, other };
  });
  return { checkedAt: new Date().toISOString(), versions: versions.reverse() };
}

const binDir = () => path.join(config.holodeckRoot, 'bin');

/** `find -printf '%P\t%s\n'` output below bin/ → files per version folder. */
export function parseListing(text: string, versions: string[]): Record<string, StagedFile[]> {
  const out: Record<string, StagedFile[]> = {};
  for (const line of text.split('\n')) {
    const [rel, size] = line.split('\t');
    if (!rel || size === undefined) continue;
    const [dir, name, ...rest] = rel.split('/');
    if (rest.length || !name || !versions.includes(dir)) continue;
    (out[dir] ??= []).push({ name, size: Number(size) });
  }
  return out;
}


/**
 * A secondary's staging, read over SSH and judged against that router's own bom.json (its Holodeck
 * version decides what its precheck accepts). Cached on the router row for placement decisions.
 */
export async function refreshRouterStaging(router: RouterRow, ssh: (cmd: string) => Promise<string>): Promise<Staging> {
  let staging: Staging;
  try {
    const out = await ssh(
      "cat /holodeck-runtime/templates/bom.json; echo; echo '#--listing--'; find /holodeck-runtime/bin -mindepth 2 -maxdepth 2 -type f -printf '%P\\t%s\\n'",
    );
    const [bomText, listing = ''] = out.split('#--listing--');
    const bom = parseBom(bomText);
    staging = evaluateStaging(bom, parseListing(listing, Object.keys(bom)));
  } catch (err) {
    const previous = cachedStaging(router);
    staging = { checkedAt: new Date().toISOString(), versions: previous?.versions ?? [], error: `Could not read staged files: ${(err as Error).message.split('\n')[0]}` };
  }
  run('UPDATE holorouters SET staging = ? WHERE id = ?', JSON.stringify(staging), router.id);
  return staging;
}

export function cachedStaging(router: Pick<RouterRow, 'staging'>): Staging | null {
  return parseJson<Staging | null>(router.staging, null);
}

/** The staging the portal currently believes a router has (refreshed by the health check and after staging). */
export function stagingOf(router: RouterRow): Staging | null {
  return cachedStaging(router);
}

export function hasVersion(router: RouterRow, version: string): boolean {
  return stagingOf(router)?.versions.some((v) => v.version === version && v.status === 'ready') ?? false;
}

export function stagingPath(version: string) {
  return `${config.holodeckRoot}/bin/${version}`;
}

/** Free bytes on the router's /holodeck-runtime. */
export async function freeBytes(ssh: (cmd: string) => Promise<string>): Promise<number> {
  const out = await ssh("df -B1 --output=avail /holodeck-runtime | tail -1");
  return Number(out.trim());
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

