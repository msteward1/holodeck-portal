/**
 * The portal's master copy of Holodeck configuration files ("<id>-site-<a|b>.json"). Holodeck still writes them
 * (New-/Set-HoloDeckConfig run on a router); the portal reads them back, keeps them encrypted (they hold the target
 * credentials) and pushes them to the router of every job (HP-SyncConfig). No Holorouter is the source of truth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { all, get, nowIso, run } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { config } from '../config.js';

export type Site = 'a' | 'b';

/** Fields that belong to one router's Holodeck state, not to the configuration. */
const ROUTER_FIELDS = ['InstanceId', 'state', 'logs', 'errorLogs', 'holorouterStatus', 'isPreCheckCompleted-a', 'isPreCheckCompleted-b'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getConfigFile(configId: string, site: Site): any | null {
  const row = get<{ data_enc: string }>('SELECT data_enc FROM holodeck_configs WHERE config_id = ? AND site = ?', configId, site);
  return row ? decrypt<object | null>(row.data_enc, null) : null;
}

/** Stores a config file as Holodeck wrote it, minus the router-specific state fields. */
export function putConfigFile(configId: string, site: Site, json: string | object) {
  if (!/^[a-z0-9]+$/i.test(configId)) throw new Error('Invalid Holodeck config id');
  const data = typeof json === 'string' ? JSON.parse(json) : { ...json };
  for (const k of ROUTER_FIELDS) delete data[k];
  run(
    `INSERT INTO holodeck_configs (config_id, site, data_enc, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(config_id, site) DO UPDATE SET data_enc = excluded.data_enc, updated_at = excluded.updated_at`,
    configId,
    site,
    encrypt(data),
    nowIso(),
  );
}

export function listConfigIds(): string[] {
  return all<{ config_id: string }>("SELECT DISTINCT config_id FROM holodeck_configs WHERE site = 'a' ORDER BY config_id").map((r) => r.config_id);
}

export function deleteConfigFiles(configId: string) {
  run('DELETE FROM holodeck_configs WHERE config_id = ?', configId);
}

/** Base64 file contents for HP-SyncConfig. */
export function configFilesForSync(configId: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const site of ['a', 'b'] as const) {
    const c = getConfigFile(configId, site);
    if (c) files[site] = Buffer.from(JSON.stringify(c, null, 2)).toString('base64');
  }
  return files;
}

/**
 * Installations that ran on a Holorouter kept the files in its /holodeck-runtime/config: adopt them once, so an
 * upgraded portal starts with the same configurations. Never overwrites what the portal already holds.
 */
export function adoptLocalConfigFiles(dir = path.join(config.holodeckRoot, 'config')): number {
  let adopted = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = /^([a-z0-9]+)-site-([ab])\.json$/i.exec(name);
    if (!m || getConfigFile(m[1], m[2] as Site)) continue;
    try {
      putConfigFile(m[1], m[2] as Site, fs.readFileSync(path.join(dir, name), 'utf8'));
      adopted += 1;
    } catch (err) {
      console.error(`could not adopt Holodeck config ${name}`, err);
    }
  }
  return adopted;
}
