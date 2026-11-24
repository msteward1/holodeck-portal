/** Read-only access to Holodeck's own files, so page loads never have to start PowerShell. */
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { config } from '../config.js';
import { getConfigFile, listConfigIds } from './configstore.js';

export interface HoloConfigSummary {
  configId: string;
  site: 'a' | 'b';
  exists: boolean;
  instanceId: string | null;
  description: string | null;
  holorouterStatus: string | null;
  precheckCompleted: boolean;
  target: {
    hostname: string | null;
    username: string | null;
    apiType: string | null;
    datacenter: string | null;
    cluster: string | null;
    resourcePool: string | null;
    datastore: string | null;
    portGroup: string | null;
  };
  version: string | null;
  domain: string | null;
  vSANMode: string | null;
  flags: Record<string, unknown>;
}


/** The portal's copy of a Holodeck config file (see configstore.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readHoloConfigRaw(configId: string, site: 'a' | 'b' = 'a'): any | null {
  if (!/^[a-z0-9]+$/i.test(configId)) return null;
  return getConfigFile(configId, site);
}

export function readHoloConfig(configId: string, site: 'a' | 'b' = 'a'): HoloConfigSummary {
  const c = readHoloConfigRaw(configId, site);
  const s = c?.['holodeck-sddc']?.[site === 'a' ? 'Site-A' : 'Site-B'] ?? {};
  const t = c?.Target ?? {};
  return {
    configId,
    site,
    exists: Boolean(c),
    instanceId: c?.InstanceId ?? null,
    description: c?.description ?? null,
    holorouterStatus: c?.holorouterStatus ?? null,
    precheckCompleted: String(c?.[`isPreCheckCompleted-${site}`]) === 'true',
    target: {
      hostname: t.hostname ?? null,
      username: t.username ?? null,
      apiType: t.targetHostApiType ?? null,
      datacenter: t.datacenter ?? null,
      cluster: t.cluster ?? null,
      resourcePool: t.resourcePool ?? null,
      datastore: t[`datastore-${site}`] ?? null,
      portGroup: t[`networkPortGroup-${site}`] ?? null,
    },
    version: s.version ?? null,
    domain: s.domain ?? null,
    vSANMode: c?.vSANMode ?? null,
    flags: {
      isVVF: s.isVVF,
      isManagementOnly: s.isManagementOnly,
      isProvisionOnly: s.isProvisionOnly,
      isNsxEdgeClusterMgmtDomain: s.isNsxEdgeClusterMgmtDomain,
      isNsxEdgeClusterWkldDomain: s.isNsxEdgeClusterWkldDomain,
      isVnaClustersMgmtDomain: s.isVnaClustersMgmtDomain,
      isVnaClustersWkldDomain: s.isVnaClustersWkldDomain,
      isVcfAutomationDeployment: s.isVcfAutomationDeployment,
      isSupervisorMgmtDomainDeployment: s.isSupervisorMgmtDomainDeployment,
      isSupervisorWldDomainDeployment: s.isSupervisorWldDomainDeployment,
      SsoType: s.SsoType,
    },
  };
}

/** Base config ids present on disk (files are <id>-site-a.json / <id>-site-b.json). */
export function listHoloConfigIds(): string[] {
  return listConfigIds();
}

export interface RouterSubnet {
  name: string;
  vlan: string;
  subnet: string;
  mask: string;
  gateway: string;
  dhcp: string;
  dhcpStart: string;
  dhcpEnd: string;
}

/** Subnets currently configured on the Holorouter for a site (written by New-HoloDeckNetworkConfig). */
export function readRouterSubnets(site: 'a' | 'b' = 'a'): RouterSubnet[] {
  const file = path.join(config.holodeckRoot, 'output', `network_manager_config_site_${site}.yaml`);
  try {
    return parseSubnets(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** Parses output/network_manager_config_site_<x>.yaml (from any Holorouter). */
export function parseSubnets(text: string | null): RouterSubnet[] {
  if (!text) return [];
  try {
    const doc = loadYaml(text) as { network_subnets_info?: Record<string, string>[] };
    return (doc.network_subnets_info ?? []).map((s) => ({
      name: s.Name,
      vlan: String(s.VLAN_ID ?? ''),
      subnet: s.Subnet,
      mask: s.SubnetMask,
      gateway: s.Gateway,
      dhcp: s.DHCP,
      dhcpStart: s.DHCP_Range_Start,
      dhcpEnd: s.DHCP_Range_End,
    }));
  } catch {
    return [];
  }
}

export function readRouterServices(): { name: string; fqdn: string; address: string }[] {
  try {
    return parseServices(fs.readFileSync(path.join(config.holodeckRoot, 'output', 'holorouter_services.yaml'), 'utf8'));
  } catch {
    return [];
  }
}

/** Parses output/holorouter_services.yaml (from any Holorouter). */
export function parseServices(text: string | null): { name: string; fqdn: string; address: string }[] {
  if (!text) return [];
  try {
    const doc = loadYaml(text) as { holorouter_services?: { name: string; fqdn: string; ip: string }[] };
    return (doc.holorouter_services ?? []).map((s) => ({ name: s.name, fqdn: s.fqdn, address: s.ip }));
  } catch {
    return [];
  }
}

/** Holodeck's own log files, newest first. */
export function listHoloLogs() {
  const dir = path.join(config.holodeckRoot, 'logs');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, modified: st.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

export function holoLogPath(name: string) {
  if (!/^[\w.-]+\.log$/.test(name)) throw new Error('Invalid log name');
  return path.join(config.holodeckRoot, 'logs', name);
}
