/**
 * Everything the portal knows about Holodeck's command surface (module 9.1.0.20).
 * The UI renders its forms from these definitions (served at /api/meta), and the
 * job builders below are the only code that turns user input into Holodeck commands.
 */
import { z } from 'zod';

export const VERSIONS = ['5.2', '5.2.1', '5.2.2', '5.2.3', '5.2.4', '9.0.0.0', '9.0.1.0', '9.0.2.0', '9.1.0.0'] as const;
export const MODES = ['VVF', 'ManagementOnly', 'FullStack'] as const;
export type DeployMode = (typeof MODES)[number];

export type FieldType = 'string' | 'password' | 'number' | 'boolean' | 'select' | 'list';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  help?: string;
  options?: readonly string[];
  required?: boolean;
  /** Deploy-form only: which modes show this field. */
  modes?: readonly DeployMode[];
  /** Only for VCF 9.x versions. */
  v9Only?: boolean;
  placeholder?: string;
  default?: unknown;
  /** Shown to administrators only (users get the portal's value). */
  adminOnly?: boolean;
  /** number: inclusive bounds. */
  min?: number;
  max?: number;
  /** list: the entries are whole numbers within itemMin..itemMax, and there are minItems..maxItems of them. */
  numericItems?: boolean;
  itemMin?: number;
  itemMax?: number;
  minItems?: number;
  maxItems?: number;
}

/** Admin-set bounds for day-2 host requests (Settings → Day-2 host limits). */
export interface HostLimits {
  cpu: { min: number; max: number; default: number };
  memoryGb: { min: number; max: number; default: number };
  disks: { min: number; max: number; default: number };
  diskSizeGb: { min: number; max: number; default: number };
  maxHostsPerSite: number;
}

/** Holodeck's own sizes: a lab is 4 hosts of 12 vCPU / 32 GB / 2 × 450 GB; an added cluster is 3 hosts. */
export const HOLODECK_BASE_HOSTS = 4;
export const HOLODECK_CLUSTER_HOSTS = 3;
export const defaultHostLimits: HostLimits = {
  cpu: { min: 2, max: 64, default: 12 },
  memoryGb: { min: 8, max: 1024, default: 32 },
  disks: { min: 1, max: 3, default: 2 },
  diskSizeGb: { min: 1, max: 16384, default: 450 },
  maxHostsPerSite: 8,
};

// ---------------------------------------------------------------------------
// New-HoloDeckInstance
// ---------------------------------------------------------------------------

export const deployFields: FieldDef[] = [
  { name: 'vSANMode', label: 'vSAN mode', type: 'select', options: ['OSA', 'ESA'], default: 'OSA', help: '-vSANMode' },
  {
    name: 'WorkloadDomainType', label: 'Workload domain SSO', type: 'select', options: ['SharedSSO', 'IsolatedSSO'],
    modes: ['FullStack'], help: '-WorkloadDomainType',
  },
  { name: 'NsxEdgeClusterMgmtDomain', label: 'NSX Edge cluster (management domain)', type: 'boolean', modes: ['ManagementOnly', 'FullStack'], help: '-NsxEdgeClusterMgmtDomain' },
  { name: 'NsxEdgeClusterWkldDomain', label: 'NSX Edge cluster (workload domain)', type: 'boolean', modes: ['FullStack'], help: '-NsxEdgeClusterWkldDomain' },
  { name: 'VnaClusterMgmtDomain', label: 'VNA cluster (management domain)', type: 'boolean', modes: ['ManagementOnly', 'FullStack'], v9Only: true, help: '-VnaClusterMgmtDomain' },
  { name: 'VnaClusterWkldDomain', label: 'VNA cluster (workload domain)', type: 'boolean', modes: ['FullStack'], v9Only: true, help: '-VnaClusterWkldDomain' },
  { name: 'DeployVcfAutomation', label: 'Deploy VCF Automation', type: 'boolean', modes: ['ManagementOnly', 'FullStack'], v9Only: true, help: '-DeployVcfAutomation' },
  {
    name: 'DeploySupervisorMgmtDomain', label: 'Supervisor (management domain)', type: 'select', options: ['', 'Centralized', 'Distributed'],
    modes: ['ManagementOnly', 'FullStack'], v9Only: true, help: '-DeploySupervisorMgmtDomain',
  },
  {
    name: 'DeploySupervisorWkldDomain', label: 'Supervisor (workload domain)', type: 'select', options: ['', 'Centralized', 'Distributed'],
    modes: ['FullStack'], v9Only: true, help: '-DeploySupervisorWkldDomain',
  },
  { name: 'ProvisionOnly', label: 'Provision only', type: 'boolean', help: '-ProvisionOnly — build nested hosts and appliances, skip VCF bring-up' },
  { name: 'DepotType', label: 'Depot type', type: 'select', options: ['Online', 'Offline'], default: 'Online', help: '-DepotType' },
  { name: 'DNSDomain', label: 'DNS domain', type: 'string', placeholder: 'lab<instance>.vcf.lab', adminOnly: true, help: '-DNSDomain (blank = the per-lab domain from Settings)' },
  { name: 'LogLevel', label: 'Log level', type: 'select', options: ['INFO', 'DEBUG', 'WARN', 'ERROR', 'SUCCESS'], default: 'INFO', help: '-LogLevel' },
];

const supervisor = z.enum(['', 'Centralized', 'Distributed']).optional();

export const deployOptionsSchema = z.object({
  mode: z.enum(MODES),
  version: z.enum(VERSIONS),
  vSANMode: z.enum(['OSA', 'ESA']).optional(),
  WorkloadDomainType: z.enum(['SharedSSO', 'IsolatedSSO']).optional(),
  NsxEdgeClusterMgmtDomain: z.boolean().optional(),
  NsxEdgeClusterWkldDomain: z.boolean().optional(),
  VnaClusterMgmtDomain: z.boolean().optional(),
  VnaClusterWkldDomain: z.boolean().optional(),
  DeployVcfAutomation: z.boolean().optional(),
  DeploySupervisorMgmtDomain: supervisor,
  DeploySupervisorWkldDomain: supervisor,
  ProvisionOnly: z.boolean().optional(),
  DepotType: z.enum(['Online', 'Offline']).optional(),
  DNSDomain: z
    .string()
    .regex(/^$|^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'Invalid DNS domain')
    .optional(),
  LogLevel: z.enum(['INFO', 'DEBUG', 'WARN', 'ERROR', 'SUCCESS']).optional(),
});
export type DeployOptions = z.infer<typeof deployOptionsSchema>;

export function isV9(version: string) {
  return version.startsWith('9.');
}

/** Drops options that don't apply to the chosen mode/version, so they never reach Holodeck. */
export function normalizeDeployOptions(o: DeployOptions): DeployOptions {
  const out: Record<string, unknown> = { mode: o.mode, version: o.version };
  for (const f of deployFields) {
    const v = (o as Record<string, unknown>)[f.name];
    if (v === undefined || v === '' || v === false) continue;
    if (f.modes && !f.modes.includes(o.mode)) continue;
    if (f.v9Only && !isV9(o.version)) continue;
    out[f.name] = v;
  }
  return out as DeployOptions;
}

/** Supervisor and VCF Automation use Holodeck's fixed 10.100.x routed (ctgw) networks. */
export function usesSharedRoutedNetworks(o: DeployOptions): boolean {
  return Boolean(o.DeployVcfAutomation || o.DeploySupervisorMgmtDomain || o.DeploySupervisorWkldDomain);
}

export function buildNewInstanceParams(
  o: DeployOptions,
  instanceId: string,
  site: { site: 'a' | 'b'; cidr: string; vlanStart: number },
): Record<string, unknown> {
  const n = normalizeDeployOptions(o);
  const p: Record<string, unknown> = {
    Version: n.version,
    InstanceID: instanceId,
    CIDR: [site.cidr],
    VLANRangeStart: [site.vlanStart],
    Site: site.site,
    DepotType: n.DepotType ?? 'Online',
    LogLevel: n.LogLevel ?? 'INFO',
    // The portal always runs unattended: depot/proxy/placement answers come from environment variables.
    DeveloperMode: true,
  };
  if (n.mode === 'VVF') p.VVF = true;
  if (n.mode === 'ManagementOnly') p.ManagementOnly = true;
  for (const f of deployFields) {
    if (['DepotType', 'LogLevel'].includes(f.name)) continue;
    const v = (n as Record<string, unknown>)[f.name];
    if (v !== undefined) p[f.name] = v;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Update-HoloDeckInstance (day-2 operations on a deployed lab)
// ---------------------------------------------------------------------------

export interface ActionDef {
  id: string;
  label: string;
  description: string;
  fields: FieldDef[];
  /** Uses the shared 10.100.x routed networks (Supervisor / VCF Automation). */
  sharedRouted?: boolean;
  v9Only?: boolean;
}

const viDomain: FieldDef = { name: 'VIDomain', label: 'Domain', type: 'select', options: ['Management', 'Workload'], required: true };

export function day2ActionsFor(h: HostLimits = defaultHostLimits): ActionDef[] {
  const sizes = `${h.disks.min === h.disks.max ? h.disks.min : `${h.disks.min}–${h.disks.max}`} disk(s), ${h.diskSizeGb.min}–${h.diskSizeGb.max} GB each`;
  return [
    {
      id: 'AddCluster',
      label: 'Add cluster',
      description: `Update-HoloDeckInstance -AdditionalCluster — adds a vSphere cluster of ${HOLODECK_CLUSTER_HOSTS} hosts to a domain.`,
      fields: [viDomain],
    },
    {
      id: 'NewHostsCustom', label: 'Add ESX hosts', description: 'Update-HoloDeckInstance -DeployNewHosts — deploys extra nested ESX hosts.',
      fields: [
        { ...viDomain, required: false },
        { name: 'CPU', label: 'vCPUs per host', type: 'number', required: true, default: h.cpu.default, min: h.cpu.min, max: h.cpu.max, help: `${h.cpu.min}–${h.cpu.max}` },
        { name: 'MemoryInGb', label: 'Memory per host (GB)', type: 'number', required: true, default: h.memoryGb.default, min: h.memoryGb.min, max: h.memoryGb.max, help: `${h.memoryGb.min}–${h.memoryGb.max} GB` },
        { name: 'Nodes', label: 'Number of hosts', type: 'number', default: 1, min: 1, max: Math.max(1, h.maxHostsPerSite - HOLODECK_BASE_HOSTS) },
        { name: 'vSANMode', label: 'vSAN mode', type: 'select', options: ['OSA', 'ESA'] },
        {
          name: 'DiskSizeInGB', label: 'Disk sizes (GB)', type: 'list',
          default: Array.from({ length: h.disks.default }, () => h.diskSizeGb.default),
          placeholder: Array.from({ length: h.disks.default }, () => h.diskSizeGb.default).join(', '),
          help: `Comma-separated; ${sizes}.`,
          numericItems: true, minItems: h.disks.min, maxItems: h.disks.max, itemMin: h.diskSizeGb.min, itemMax: h.diskSizeGb.max,
        },
      ],
    },
    {
      id: 'DeploySupervisor', label: 'Deploy Supervisor', description: 'Update-HoloDeckInstance -DeploySupervisor',
      sharedRouted: true, v9Only: true,
      fields: [viDomain, { name: 'SupervisorDeploymentMode', label: 'Deployment mode', type: 'select', options: ['Distributed', 'Centralized'] }],
    },
    {
      id: 'VcfAutomation', label: 'Add VCF Automation All-Apps org', description: 'Update-HoloDeckInstance -AddVcfAutomationAllAppsOrg',
      sharedRouted: true, v9Only: true, fields: [viDomain],
    },
    {
      id: 'DeployVcfAutomation', label: 'Deploy VCF Automation', description: 'Update-HoloDeckInstance -DeployVcfAutomation',
      sharedRouted: true, v9Only: true, fields: [],
    },
  ];
}

/** With Holodeck's default sizes; use day2ActionsFor(settings) where the admin limits apply. */
export const day2Actions: ActionDef[] = day2ActionsFor();

/** Hosts a day-2 action adds to its site. */
export function hostsAdded(actionId: string, params: Record<string, unknown>): number {
  if (actionId === 'AddCluster') return HOLODECK_CLUSTER_HOSTS;
  if (actionId === 'NewHostsCustom') return Number(params.Nodes ?? 1) || 1;
  return 0;
}

export function buildDay2Params(actionId: string, values: Record<string, unknown>, site: string, limits: HostLimits = defaultHostLimits): Record<string, unknown> {
  const action = day2ActionsFor(limits).find((a) => a.id === actionId);
  if (!action) throw new Error(`Unknown action ${actionId}`);
  const p: Record<string, unknown> = { Site: site };
  const switchName: Record<string, string> = {
    AddCluster: 'AdditionalCluster',
    NewHostsCustom: 'DeployNewHosts',
    DeploySupervisor: 'DeploySupervisor',
    VcfAutomation: 'AddVcfAutomationAllAppsOrg',
    DeployVcfAutomation: 'DeployVcfAutomation',
  };
  p[switchName[actionId]] = true;
  Object.assign(p, coerceFields(action.fields, values));
  return p;
}

// ---------------------------------------------------------------------------
// Set-HoloDeckConfig parameter sets (admin configuration editor)
// ---------------------------------------------------------------------------

export interface ConfigSetDef {
  id: string;
  label: string;
  description: string;
  group: 'Target' | 'Deployment' | 'Depot' | 'Advanced';
  fields: FieldDef[];
  /** Fields to mask in the job log. */
  redact?: string[];
}

const domainField: FieldDef = { name: 'Domain', label: 'Domain', type: 'select', options: ['Management', 'Workload'] };

export const configSets: ConfigSetDef[] = [
  {
    id: 'Credentials', label: 'Target host credentials', group: 'Target',
    description: 'Target vCenter/ESX host and credentials (-TargetHost -Username -Password).',
    fields: [
      { name: 'TargetHost', label: 'Target host', type: 'string', required: true },
      { name: 'Username', label: 'Username', type: 'string', required: true },
      { name: 'Password', label: 'Password', type: 'password', required: true },
    ],
    redact: ['Password'],
  },
  {
    id: 'ClusterConfig', label: 'Placement', group: 'Target',
    description: 'Datacenter, cluster, resource pool, datastore and trunk port group on the target.',
    fields: [
      { name: 'TargetDatacenter', label: 'Datacenter', type: 'string' },
      { name: 'TargetCluster', label: 'Cluster', type: 'string' },
      { name: 'TargetResourcePool', label: 'Resource pool', type: 'string' },
      { name: 'TargetDatastore', label: 'Datastore', type: 'string' },
      { name: 'TargetNetwork', label: 'Trunk port group', type: 'string' },
      { name: 'DeprecatedCPU', label: 'Deprecated CPU', type: 'select', options: ['', 'True', 'False'] },
    ],
  },
  {
    id: 'TargetHostApiType', label: 'Target API type', group: 'Target', description: '-TargetHostApiType',
    fields: [{ name: 'TargetHostApiType', label: 'API type', type: 'select', options: ['VirtualCenter', 'HostAgent'], required: true }],
  },
  { id: 'HostAgent', label: 'Host agent mode', group: 'Target', description: '-HostAgent', fields: [{ name: 'HostAgent', label: 'Target is a standalone ESX host', type: 'boolean' }] },
  {
    id: 'version', label: 'Version', group: 'Deployment', description: '-Version [-ManagementOnly] [-VVF]',
    fields: [
      { name: 'Version', label: 'Version', type: 'select', options: VERSIONS, required: true },
      { name: 'ManagementOnly', label: 'Management only', type: 'boolean' },
      { name: 'VVF', label: 'VVF', type: 'boolean' },
    ],
  },
  { id: 'vSAN', label: 'vSAN mode', group: 'Deployment', description: '-vSANMode', fields: [{ name: 'vSANMode', label: 'vSAN mode', type: 'select', options: ['OSA', 'ESA'], required: true }] },
  { id: 'ISO', label: 'vSphere ISO', group: 'Deployment', description: '-vSphereISO', fields: [{ name: 'vSphereISO', label: 'ISO file name', type: 'string', required: true }] },
  {
    id: 'WorkloadDomainType', label: 'Workload domain SSO', group: 'Deployment', description: '-WorkloadDomainType',
    fields: [{ name: 'WorkloadDomainType', label: 'SSO type', type: 'select', options: ['SharedSSO', 'IsolatedSSO'], required: true }],
  },
  {
    id: 'SupervisorDeploymentMode', label: 'Supervisor deployment mode', group: 'Deployment', description: '-SupervisorMgmtDeploymentMode -SupervisorWkldDeploymentMode',
    fields: [
      { name: 'SupervisorMgmtDeploymentMode', label: 'Management domain', type: 'select', options: ['', 'Centralized', 'Distributed'] },
      { name: 'SupervisorWkldDeploymentMode', label: 'Workload domain', type: 'select', options: ['', 'Centralized', 'Distributed'] },
    ],
  },
  {
    id: 'Proxy', label: 'Depot proxy', group: 'Depot', description: '-ProxyProtocol -ProxyIP -ProxyPort -ProxyUsername -ProxyPassword',
    fields: [
      { name: 'ProxyProtocol', label: 'Protocol', type: 'select', options: ['HTTP', 'HTTPS'] },
      { name: 'ProxyIP', label: 'Proxy FQDN/IP', type: 'string' },
      { name: 'ProxyPort', label: 'Port', type: 'string' },
      { name: 'ProxyUsername', label: 'Username', type: 'string' },
      { name: 'ProxyPassword', label: 'Password', type: 'password' },
    ],
    redact: ['ProxyPassword'],
  },
  {
    id: 'OfflineDepot', label: 'Offline depot', group: 'Depot', description: '-OfflineDepotIP -OfflineDepotPort -OfflineDepotProtocol -OfflineDepotUsername -OfflineDepotPassword',
    fields: [
      { name: 'OfflineDepotIP', label: 'Depot FQDN/IP', type: 'string' },
      { name: 'OfflineDepotPort', label: 'Port', type: 'string' },
      { name: 'OfflineDepotProtocol', label: 'Protocol', type: 'select', options: ['http', 'https'] },
      { name: 'OfflineDepotUsername', label: 'Username', type: 'string' },
      { name: 'OfflineDepotPassword', label: 'Password', type: 'password' },
    ],
    redact: ['OfflineDepotPassword'],
  },
  {
    id: 'VcfAutomationHostProtectionJob', label: 'VCF Automation host protection', group: 'Advanced', description: 'Background job that protects VCF Automation hosts.',
    fields: [
      { name: 'VcfAutomationHostProtectionJobEnabled', label: 'Enabled', type: 'boolean' },
      { name: 'VcfAutomationHostProtectionJobVcenterIP', label: 'vCenter IP', type: 'string' },
      { name: 'VcfAutomationHostProtectionJobUsername', label: 'Username', type: 'string' },
      { name: 'VcfAutomationHostProtectionJobPassword', label: 'Password', type: 'password' },
      { name: 'VcfAutomationHostProtectionJobClusterName', label: 'Cluster name', type: 'string' },
      { name: 'VcfAutomationHostProtectionJobInstancePrefix', label: 'Instance prefix', type: 'string' },
      { name: 'VcfAutomationHostProtectionJobLogFile', label: 'Log file', type: 'string' },
    ],
    redact: ['VcfAutomationHostProtectionJobPassword'],
  },
  {
    id: 'NsxEdgeCluster', label: 'NSX Edge cluster ID', group: 'Advanced', description: '-ClusterId -Domain',
    fields: [{ name: 'ClusterId', label: 'Cluster ID', type: 'string' }, domainField],
  },
  { id: 'T0Path', label: 'Tier-0 path', group: 'Advanced', description: '-T0Path -Domain', fields: [{ name: 'T0Path', label: 'T0 path', type: 'string' }, domainField] },
  { id: 'WorkloadDomain', label: 'Workload network pool', group: 'Advanced', description: '-NetworkId', fields: [{ name: 'NetworkId', label: 'Network ID', type: 'string', required: true }] },
  {
    id: 'WorkloadDomainDetails', label: 'Workload domain details', group: 'Advanced', description: '-WorkloadDomainClusterImageId -WorkloadDomainHostIds',
    fields: [
      { name: 'WorkloadDomainClusterImageId', label: 'Cluster image ID', type: 'string', required: true },
      { name: 'WorkloadDomainHostIds', label: 'Host IDs', type: 'list', required: true },
    ],
  },
  { id: 'Avn', label: 'AVN edge cluster', group: 'Advanced', description: '-AvnEdgeClusterId', fields: [{ name: 'AvnEdgeClusterId', label: 'Edge cluster ID', type: 'string', required: true }] },
  {
    id: 'VnaClusterSpec', label: 'VNA cluster spec', group: 'Advanced', description: '-VnaDomain -VnaComputeManagerId …',
    fields: [
      { name: 'VnaDomain', label: 'Domain', type: 'select', options: ['Management', 'Workload'] },
      { name: 'VnaComputeManagerId', label: 'Compute manager ID', type: 'string' },
      { name: 'VnaClusterOrResourcePoolId', label: 'Cluster / resource pool ID', type: 'string' },
      { name: 'VnaDatastoreId', label: 'Datastore ID', type: 'string' },
      { name: 'VnaManagementNetworkId', label: 'Management network ID', type: 'string' },
    ],
  },
  {
    id: 'SupervisorMgmtDomainSpec', label: 'Supervisor spec (management)', group: 'Advanced', description: '-SupervisorMgmtDomain*',
    fields: ['ClusterId', 'StoragePolicyId', 'MgmtNetworkId', 'VpcConnectivityProfileId'].map((s) => ({
      name: `SupervisorMgmtDomain${s}`, label: s.replace(/Id$/, ' ID'), type: 'string' as const,
    })),
  },
  {
    id: 'SupervisorWkldDomainSpec', label: 'Supervisor spec (workload)', group: 'Advanced', description: '-SupervisorWkldDomain*',
    fields: ['ClusterId', 'StoragePolicyId', 'MgmtNetworkId', 'VpcConnectivityProfileId'].map((s) => ({
      name: `SupervisorWkldDomain${s}`, label: s.replace(/Id$/, ' ID'), type: 'string' as const,
    })),
  },
  {
    id: 'AdditionalCluster', label: 'Additional cluster', group: 'Advanced', description: '-AdditionalCluster*',
    fields: [
      { name: 'AdditionalClusterType', label: 'Type', type: 'select', options: ['Management', 'Workload'] },
      { name: 'AdditionalClusterDomainId', label: 'Domain ID', type: 'string' },
      { name: 'AdditionalClusterHostIds', label: 'Host IDs', type: 'list' },
      { name: 'AdditionalClusterImageId', label: 'Image ID', type: 'string' },
      { name: 'AdditionalClusterNetworkId', label: 'Network ID', type: 'string' },
      { name: 'AdditionalClusterSetup', label: 'Setup', type: 'boolean' },
    ],
  },
  ...(
    [
      ['NetworkConfig', 'Regenerate network config'],
      ['NsxEdgeClusterMgmtDomain', 'NSX Edge cluster (mgmt) flag'],
      ['NsxEdgeClusterWkldDomain', 'NSX Edge cluster (wkld) flag'],
      ['VnaClusterMgmtDomain', 'VNA cluster (mgmt) flag'],
      ['VnaClusterWkldDomain', 'VNA cluster (wkld) flag'],
      ['ProvisionOnly', 'Provision-only flag'],
      ['DeployVcfAutomation', 'Deploy VCF Automation flag'],
    ] as const
  ).map(([id, label]) => ({
    id, label, group: 'Advanced' as const, description: `-${id}`,
    fields: [{ name: id, label, type: 'boolean' as const }],
  })),
  {
    id: 'DeploySupervisorMgmtDomain', label: 'Supervisor (mgmt) mode', group: 'Advanced', description: '-DeploySupervisorMgmtDomain',
    fields: [{ name: 'DeploySupervisorMgmtDomain', label: 'Mode', type: 'select', options: ['Centralized', 'Distributed'], required: true }],
  },
  {
    id: 'DeploySupervisorWkldDomain', label: 'Supervisor (wkld) mode', group: 'Advanced', description: '-DeploySupervisorWkldDomain',
    fields: [{ name: 'DeploySupervisorWkldDomain', label: 'Mode', type: 'select', options: ['Centralized', 'Distributed'], required: true }],
  },
  {
    id: 'custom', label: 'Custom key/value', group: 'Advanced', description: '-ConfigKey -ConfigValue — sets any top-level config key.',
    fields: [
      { name: 'ConfigKey', label: 'Key', type: 'string', required: true },
      { name: 'ConfigValue', label: 'Value', type: 'string', required: true },
    ],
  },
];

/** Validates and converts form values to the types Holodeck expects. Unknown fields are dropped. */
export function coerceFields(fields: FieldDef[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) throw new Error(`${f.label} is required`);
      continue;
    }
    switch (f.type) {
      case 'boolean':
        if (v === true || v === 'true') out[f.name] = true;
        break;
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`${f.label} must be a number`);
        const i = Math.trunc(n);
        if ((f.min !== undefined || f.max !== undefined) && (i !== n || i < (f.min ?? -Infinity) || i > (f.max ?? Infinity))) {
          throw new Error(`${f.label} must be a whole number from ${f.min ?? '…'} to ${f.max ?? '…'}`);
        }
        out[f.name] = i;
        break;
      }
      case 'select':
        if (!f.options?.includes(String(v))) throw new Error(`${f.label}: invalid choice`);
        out[f.name] = String(v);
        break;
      case 'list': {
        const items = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);
        if (f.numericItems) {
          const nums = items.map(Number);
          if (nums.some((n) => !Number.isInteger(n) || n < (f.itemMin ?? 1) || n > (f.itemMax ?? Infinity))) {
            throw new Error(`${f.label}: each entry must be a whole number from ${f.itemMin ?? 1} to ${f.itemMax ?? '…'}`);
          }
          if (nums.length < (f.minItems ?? 0) || nums.length > (f.maxItems ?? Infinity)) {
            throw new Error(`${f.label}: give ${f.minItems === f.maxItems ? f.minItems : `${f.minItems ?? 0} to ${f.maxItems}`} value(s)`);
          }
          out[f.name] = nums.map(String);
        } else out[f.name] = items;
        break;
      }
      default:
        out[f.name] = String(v);
    }
  }
  return out;
}

export function buildConfigSetParams(setId: string, values: Record<string, unknown>, site: string) {
  const set = configSets.find((s) => s.id === setId);
  if (!set) throw new Error(`Unknown configuration set ${setId}`);
  const params = coerceFields(set.fields, values);
  if (Object.keys(params).length === 0) throw new Error('Nothing to change');
  // ByConfigID/Default sets take no -site; all others target the imported site's file.
  if (setId !== 'Credentials') params.site = site;
  return { params, redact: set.redact ?? [] };
}
