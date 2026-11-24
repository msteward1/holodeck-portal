export type Role = 'admin' | 'user';

export interface User {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  email: string | null;
  role: Role;
  authSource: 'local' | 'oidc' | 'saml';
  enabled: boolean;
  labQuota: number | null;
  effectiveQuota: number;
  createdAt?: string;
  lastLoginAt?: string | null;
  activeLabs?: number;
  /** Admin list only: an SSO account bound to an IdP subject. */
  ssoLinked?: boolean;
}

export type LabStatus = 'queued' | 'deploying' | 'ready' | 'failed' | 'removing' | 'removed';
export type DeployMode = 'VVF' | 'ManagementOnly' | 'FullStack';

export interface SiteAllocation {
  site: 'a' | 'b';
  cidr: string;
  vlanStart: number;
  vlanEnd: number;
  reserved: boolean;
}

export interface ConsoleLink {
  label: string;
  url: string;
  fqdn: string;
  ip: string;
}

export interface Subnet {
  name: string;
  vlan: string;
  subnet: string;
  mask: string;
  gateway: string;
  dhcp: string;
  dhcpStart: string;
  dhcpEnd: string;
}

export interface LabNode {
  name: string;
  ip: string;
  type: string;
  powerState?: string;
  reachable?: boolean;
  domain?: string | null;
}

export interface Lab {
  id: number;
  name: string;
  description: string;
  /** Idle policy standing; null for removed labs. */
  idle: LabIdle | null;
  instanceId: string;
  owner: { id: number; username: string; name: string } | null;
  config: { id: number; name: string; configId: string } | null;
  slot: number;
  sites: SiteAllocation[];
  deploySite: 'a' | 'b';
  version: string;
  mode: DeployMode;
  options: Record<string, unknown>;
  status: LabStatus;
  powerState: string;
  lease: { expiresAt: string; expired: boolean; warnedLevel: number };
  usesSharedRouted: boolean;
  error: string | null;
  createdAt: string;
  deployedAt: string | null;
  removedAt: string | null;
  activeJob: { id: string; type: string; status: JobStatus; startedAt: string | null } | null;
  lastJobId: string | null;
  hasCredentials: boolean;
  links: ConsoleLink[];
  nodeCount: number;
  domain: string | null;
  holorouter: { id: number; name: string; slot: number; status: string; webtopUrl: string | null } | null;
  nodes?: LabNode[];
  network?: { subnets?: Subnet[]; bgp?: { routerAs?: number; edgeMgmtAs?: number; edgeWldAs?: number } | null; domain?: string | null };
  endpoints?: { hostname: string; fqdn: string; ip: string }[];
  /** Nested hosts at the deploy site against the admin's per-site limit. */
  hosts?: { site: string; count: number; max: number; unconfirmed?: boolean };
}

export type JobStatus = 'queued' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  type: string;
  labId: number | null;
  configId: number | null;
  userId: number | null;
  status: JobStatus;
  display: Record<string, unknown>;
  prompt: { prompt: string; secure: boolean; index: number } | null;
  result: Record<string, unknown> | null;
  error: string | null;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  username?: string | null;
  labName?: string | null;
}

export type FieldType = 'string' | 'password' | 'number' | 'boolean' | 'select' | 'list';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  help?: string;
  options?: string[];
  required?: boolean;
  modes?: DeployMode[];
  v9Only?: boolean;
  placeholder?: string;
  default?: unknown;
  adminOnly?: boolean;
  min?: number;
  max?: number;
}

export interface ActionDef {
  id: string;
  label: string;
  description: string;
  fields: FieldDef[];
  sharedRouted?: boolean;
  v9Only?: boolean;
}

export interface ConfigSetDef {
  id: string;
  label: string;
  description: string;
  group: 'Target' | 'Deployment' | 'Depot' | 'Advanced';
  fields: FieldDef[];
}

export interface Meta {
  versions: string[];
  modes: DeployMode[];
  deployFields: FieldDef[];
  day2Actions: ActionDef[];
  configSets: ConfigSetDef[];
  lease: { defaultDays: number; maxDays: number; usersCanExtend: boolean };
  portalName: string;
  /** Dashboard notices for this user (administrators only today). */
  notices?: { id: string; title: string; message: string; warning?: string }[];
}

export interface DeployConfig {
  id: number;
  name: string;
  description: string;
  configId: string;
  defaults: Record<string, unknown>;
  target: { hostname: string | null; cluster: string | null; datastore: string | null };
  version: string | null;
  /** available: a free Holorouter serves it; busy: all of its routers are in use; unmapped: none serves it (admins only). */
  availability: 'available' | 'busy' | 'unmapped';
}

export interface Dashboard {
  labs: { active: number; ready: number; poweredOn: number; deploying: number; failed: number; expiringSoon: number; expired: number };
  capacity: { used: number; max: number; slots: number; configuredMax: number };
  quota: { used: number; max: number };
  jobs: { running: number; waitingInput: number };
}

export interface NotificationItem {
  id: number;
  labId: number | null;
  level: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
}

export interface PoolSlot {
  slot: number;
  sites: SiteAllocation[];
  lab: { id: number; name: string; instanceId: string; status: string } | { inUse: true } | null;
  holorouter: { id?: number; name?: string; status: string } | null;
}

export type HolorouterStatus = 'onboarding' | 'deploying' | 'ready' | 'attention' | 'offline' | 'error' | 'removing';

export interface RouterInspection {
  hostname?: string;
  checkedAt?: string;
  holodeckVersion?: string | null;
  cpus?: number;
  memoryGB?: number;
  diskFreeGB?: number;
  nics?: { name: string; present: boolean; state: string; ip: string }[];
  configs?: { file: string; instanceId: string | null; holorouterStatus: string | null }[];
  instances?: string[];
  startupScript?: boolean;
  vlanInterfaces?: number;
  kubernetes?: { reachable: boolean; pods: number; notReady: string[] };
  webtop?: { httpStatus: string; ok: boolean };
  vcenterReachable?: boolean;
}

export interface Holorouter {
  id: number;
  name: string;
  address: string;
  /** Pinned SSH host key ("ssh-ed25519 SHA256:…"). */
  hostKey: string | null;
  /** Another router presents the same host key: the OVA's shipped key. */
  hostKeyShared?: boolean;
  mgmtIp: string | null;
  slot: number;
  network: SiteAllocation[];
  /** Also the portal's own host (the former primary during the move to a portal appliance). */
  hostsPortal?: boolean;
  origin: 'primary' | 'imported' | 'deployed';
  status: HolorouterStatus;
  profile: { id: number; name: string } | null;
  vmName: string | null;
  holodeckVersion: string | null;
  lastSeenAt: string | null;
  lastJobId: string | null;
  error: string | null;
  inspection: RouterInspection | null;
  blockers: string[];
  warnings: string[];
  webtopUrl: string | null;
  webtop: { gatewayEnabled: boolean; mode: WebtopMode | null; effectiveMode: WebtopMode; firewall: string | null; gatewayPort: number };
  idle: {
    policy: { mode: 'default' } | { mode: 'off' } | { mode: 'custom'; suspend: IdleStage; shutdown: IdleStage };
    effective: { suspend: IdleStage; shutdown: IdleStage; source: 'default' | 'off' | 'custom' };
    default: { suspend: IdleStage; shutdown: IdleStage };
  };
  lab: { id: number; name: string; instanceId: string; status: string } | null;
  staging: Staging | null;
  stagingJobId: string | null;
  createdAt: string;
}

export interface StagedFile {
  name: string;
  size: number;
}

export interface VersionStaging {
  version: string;
  status: 'ready' | 'incomplete' | 'missing';
  esx: StagedFile | null;
  installer: StagedFile | null;
  installerKind: 'vcf-installer' | 'cloud-builder';
  expected: { esx: string[]; installer: string[] };
  other: StagedFile[];
}

export interface Staging {
  checkedAt: string;
  versions: VersionStaging[];
  error?: string;
}

export interface CapacityProfile {
  id: number;
  name: string;
  configId: number;
  configName: string | null;
  vcenter: string | null;
  datacenter: string;
  cluster: string;
  resourcePool: string;
  folder: string;
  datastore: string;
  mgmtNetwork: string;
  trunkA: string;
  trunkB: string;
  vcenterCertificate: VCenterCert | null;
  /** 'esxi' for a standalone ESXi host (Holodeck HostAgent); null until the inventory or a job has connected. */
  targetType: 'vcenter' | 'esxi' | null;
  license: TargetLicense | null;
  routers: { id: number; name: string }[];
  updatedAt: string;
}

export interface VCenterCert {
  host: string;
  sha256: string;
  sha1: string;
  subject: string;
  issuer: string;
  validTo: string;
  /** vCenter's CA, captured at approval for strict verification of the deploy job's sign-in. */
  caPem?: string;
  nameMatches?: boolean;
}

export interface TargetLicense {
  edition: string;
  name?: string;
  evaluation: boolean;
  hoursLeft: number | null;
  /** The target accepts API writes (router deployment): false for the free ESXi licence or an ended evaluation. */
  writable: boolean;
}

export interface VCenterInventory {
  fetchedAt: string;
  apiType?: string;
  license?: TargetLicense;
  datacenters: {
    name: string;
    folders: string[];
    clusters: {
      name: string;
      /** 'host' when the entry is a standalone ESXi host rather than a cluster. */
      kind?: 'host';
      resourcePools: string[];
      datastores: { name: string; type: string; capacityGB: number; freeGB: number }[];
      networks: { name: string; type: 'standard' | 'distributed' }[];
    }[];
  }[];
}

export interface WebtopAccess {
  url: string | null;
  router: string;
  /** Opened through the portal's webtop gateway: signed in automatically, no password shown. */
  viaPortal?: boolean;
  username: string | null;
  password: string | null;
}

export type WebtopMode = 'direct' | 'portal' | 'portal-only';

export interface IdleStage {
  enabled: boolean;
  days: number;
}

/** A lab's standing under the idle policy. */
export interface LabIdle {
  enabled: boolean;
  exempt: boolean;
  policy: { suspend: IdleStage; shutdown: IdleStage; source: 'default' | 'off' | 'custom' };
  lastActivityAt: string;
  idleDays: number;
  next: { action: 'suspend' | 'shutdown'; at: string } | null;
}
