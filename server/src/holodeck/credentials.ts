/**
 * Turns the raw password paths collected from a Holodeck config (HP-Snapshot) into a short,
 * de-duplicated list a lab user can read.
 */

export interface RawCredential {
  path: string;
  username: string | null;
  password: string;
}

export interface Credential {
  component: string;
  account: string;
  password: string;
}

interface Rule {
  test: RegExp;
  component: string;
  account: string | ((c: RawCredential) => string);
}

// Order matters: first match wins.
const rules: Rule[] = [
  { test: /^bgp\./, component: 'BGP', account: 'Peer password' },
  { test: /hostSpecs?\[|hostsSpec\[|\.esx\./i, component: 'ESX hosts', account: 'root' },
  { test: /vcenterSpec\.adminUserSsoPassword|pscSpecs.*adminUserSsoPassword/i, component: 'vCenter', account: 'administrator@vsphere.local' },
  { test: /vcenterSpec\.root/i, component: 'vCenter', account: 'root' },
  { test: /edge(Admin)Password/i, component: 'NSX Edge', account: 'admin' },
  { test: /edgeAuditPassword/i, component: 'NSX Edge', account: 'audit' },
  { test: /edgeRootPassword/i, component: 'NSX Edge', account: 'root' },
  { test: /nsx.*(Admin|nsxManagerAdmin)Password/i, component: 'NSX Manager', account: 'admin' },
  { test: /nsx.*AuditPassword/i, component: 'NSX Manager', account: 'audit' },
  { test: /nsx.*root/i, component: 'NSX Manager', account: 'root' },
  { test: /sddcManagerSpec\.localUserPassword/i, component: 'SDDC Manager', account: 'admin@local' },
  { test: /sddcManagerSpec\.rootPassword/i, component: 'SDDC Manager', account: 'root' },
  { test: /sddcManagerSpec\.sshPassword/i, component: 'SDDC Manager', account: 'vcf' },
  { test: /sddcManagerSpec\.(secondUserCredentials|rootUserCredentials)/i, component: 'SDDC Manager', account: (c) => c.username ?? 'user' },
  { test: /vcfOperationsFleetManagementSpec/i, component: 'VCF Operations Fleet Management', account: (c) => (/root/i.test(c.path) ? 'root' : 'admin@local') },
  { test: /vcfOperationsCollectorSpec/i, component: 'VCF Operations Collector', account: 'root' },
  { test: /allAppsOrgSpec/i, component: 'VCF Automation (All-Apps org)', account: (c) => c.username ?? 'user' },
  { test: /vcfOperationsSpec/i, component: 'VCF Operations', account: (c) => (/root/i.test(c.path) ? 'root' : 'admin') },
  { test: /automation/i, component: 'VCF Automation', account: (c) => c.username ?? 'admin' },
  { test: /^vcf-installer\.rootPassword/, component: 'VCF Installer', account: 'root' },
  { test: /^vcf-installer\.localUserPassword/, component: 'VCF Installer', account: 'admin@local' },
  { test: /^cloud-builder\.adminPassword/, component: 'Cloud Builder', account: 'admin' },
  { test: /^cloud-builder\.rootPassword/, component: 'Cloud Builder', account: 'root' },
];

/** Config sections that only apply to some versions. */
function relevantToVersion(path: string, version: string): boolean {
  const v9 = version.startsWith('9.');
  if (/^(cloud-builder|cb-)/.test(path)) return !v9;
  if (/^(vcf-installer|vvf-9|vcf-9)/.test(path)) {
    if (!v9) return false;
    const m = /^(vvf|vcf)-(9)-(\d)/.exec(path);
    if (m) return version.startsWith(`9.${m[3]}`);
    return true;
  }
  return true;
}

export function curateCredentials(raw: RawCredential[], version: string): Credential[] {
  const seen = new Set<string>();
  const out: Credential[] = [];
  for (const c of raw) {
    if (!c.password || !relevantToVersion(c.path, version)) continue;
    const rule = rules.find((r) => r.test.test(c.path));
    const component = rule?.component ?? c.path.split('.')[0];
    const account = rule ? (typeof rule.account === 'function' ? rule.account(c) : rule.account) : c.username ?? c.path.split('.').slice(1).join('.');
    const key = `${component}\u0000${account}\u0000${c.password}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ component, account, password: c.password });
  }
  return out.sort((a, b) => a.component.localeCompare(b.component) || a.account.localeCompare(b.account));
}

/** Well-known consoles, matched against the endpoint list by hostname. */
const consoleDefs: { label: string; host: RegExp; modes?: string[]; path?: string }[] = [
  { label: 'vCenter (management)', host: /^vc-mgmt-[ab]$/, path: '/ui' },
  { label: 'SDDC Manager', host: /^sddcmanager-[ab]$/, modes: ['ManagementOnly', 'FullStack'] },
  { label: 'NSX Manager (management)', host: /^nsx-mgmt-[ab]$/, modes: ['ManagementOnly', 'FullStack'] },
  { label: 'VCF Installer', host: /vcfinstaller|^installer-[ab]$/ },
  { label: 'VCF Operations', host: /^ops-[ab]$/ },
  { label: 'VCF Automation', host: /^auto-[ab]$/ },
  { label: 'vCenter (workload)', host: /^vc-wld01-[ab]$/, modes: ['FullStack'], path: '/ui' },
  { label: 'NSX Manager (workload)', host: /^nsx-wld01-[ab]$/, modes: ['FullStack'] },
];

export interface Endpoint {
  hostname: string;
  fqdn: string;
  ip: string;
}

export function consoleLinks(endpoints: Endpoint[], mode: string, nodes: { name: string; ip: string; type: string }[]) {
  const links: { label: string; url: string; fqdn: string; ip: string }[] = [];
  for (const def of consoleDefs) {
    if (def.modes && !def.modes.includes(mode)) continue;
    const ep = endpoints.find((e) => def.host.test(e.hostname));
    if (!ep) continue;
    links.push({ label: def.label, url: `https://${ep.fqdn}${def.path ?? ''}`, fqdn: ep.fqdn, ip: ep.ip });
  }
  // Appliances Holodeck registered as nodes but not in the endpoint list (e.g. VCF Installer).
  for (const n of nodes) {
    if (n.type === 'VCF_Installer' && !links.some((l) => l.label === 'VCF Installer')) {
      const fqdn = n.name.includes('.') ? n.name : n.ip;
      links.push({ label: 'VCF Installer', url: `https://${fqdn}`, fqdn, ip: n.ip });
    }
  }
  return links;
}
