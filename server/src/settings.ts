import { z } from 'zod';
import { all, run } from './db.js';
import { decrypt, encrypt } from './crypto.js';

const duration = z.object({
  value: z.number().int().min(1).max(10000),
  unit: z.enum(['hours', 'days']),
});
export type Duration = z.infer<typeof duration>;

export function durationMs(d: Duration): number {
  return d.value * (d.unit === 'days' ? 24 : 1) * 3600_000;
}

const groupList = z.array(z.string().min(1)).default([]);

/** One stage of the idle policy: act once a lab has had no sign of use for this many days. */
export const idleStage = z.object({
  enabled: z.boolean().default(false),
  days: z.number().int().min(1).max(365).default(7),
});
export type IdleStage = z.infer<typeof idleStage>;

/** min ≤ default ≤ max, all within the hard range lo..hi. */
function hostRange(lo: number, hi: number, def: number) {
  const n = z.number().int().min(lo).max(hi);
  return z
    .object({ min: n.default(lo), max: n.default(hi), default: n.default(def) })
    .refine((r) => r.min <= r.default && r.default <= r.max, 'Use minimum ≤ default ≤ maximum')
    .prefault({});
}

export const settingsSchema = z.object({
  general: z
    .object({
      portalName: z.string().min(1).max(60).default('Holodeck Portal'),
      /** Audit entries older than this are deleted by the hourly clean-up. */
      auditRetentionDays: z.number().int().min(30).max(3650).default(365),
    })
    .prefault({}),
  capacity: z
    .object({
      /** Admin-tunable ceiling on concurrently provisioned labs (all users). */
      maxActiveLabs: z.number().int().min(1).max(10).default(1),
      /** Default per-user lab quota; can be overridden per user. */
      defaultUserQuota: z.number().int().min(0).max(10).default(2),
      /** Unused since the portal no longer runs on a Holorouter (kept so older settings still load). */
      primaryLabAccess: z.enum(['all', 'admins']).default('all'),
    })
    .prefault({}),
  jobs: z
    .object({
      /** A job waiting for an answer this long is cancelled (0 = never). */
      promptTimeoutHours: z.number().int().min(0).max(720).default(72),
      /** The owner is reminded once after this long (0 = no reminder). */
      promptReminderHours: z.number().int().min(0).max(720).default(24),
    })
    .prefault({}),
  /** Day-2 "Add ESX hosts" bounds and the hosts-per-site budget. */
  hosts: z
    .object({
      cpu: hostRange(2, 64, 12),
      memoryGb: hostRange(8, 1024, 32),
      disks: hostRange(1, 3, 2),
      diskSizeGb: hostRange(1, 16384, 450),
      /** Total nested hosts per lab site: 4 from the deployment, 3 per added cluster, plus added hosts. */
      maxHostsPerSite: z.number().int().min(4).max(64).default(8),
    })
    .prefault({}),
  lease: z
    .preprocess(
      // Leases used to be set in hours: convert once (rounding up) when the stored section predates days.
      (v) => {
        if (!v || typeof v !== 'object') return v;
        const o = { ...(v as Record<string, unknown>) };
        if (o.defaultDays === undefined && typeof o.defaultHours === 'number') o.defaultDays = Math.min(365, Math.max(1, Math.ceil(o.defaultHours / 24)));
        if (o.maxDays === undefined && typeof o.maxHours === 'number') o.maxDays = Math.min(365, Math.max(1, Math.ceil(o.maxHours / 24)));
        delete o.defaultHours;
        delete o.maxHours;
        return o;
      },
      z.object({
      defaultDays: z.number().int().min(1).max(365).default(14),
      maxDays: z.number().int().min(1).max(365).default(365),
      usersCanExtend: z.boolean().default(true),
      firstWarning: duration.default({ value: 1, unit: 'days' }),
      secondWarning: duration.default({ value: 2, unit: 'hours' }),
      }),
    )
    .prefault({}),
  network: z
    .object({
      firstOctet: z.number().int().min(1).max(223).default(10),
      secondOctetStart: z.number().int().min(0).max(255).default(1),
      secondOctetEnd: z.number().int().min(0).max(255).default(10),
      /** /20s reserved per lab: site a deployed now, site b reserved for future dual-site support. */
      sitesPerLab: z.literal(2).default(2),
      vlanMultiplier: z.number().int().min(1).max(1000).default(100),
      /** VLANs used elsewhere (e.g. "1210-1218"): pool ranges whose VLANs touch them are skipped. */
      blockedVlans: z.string().max(2000).default(''),
      /** Networks used elsewhere (e.g. "192.0.2.0/24"): pool ranges overlapping them are skipped. */
      blockedNetworks: z.string().max(4000).default(''),
      /** Per-lab DNS domain; {instance} is replaced with the lab's instance ID. */
      /** Per-lab DNS domain: {slot} = the lab's network slot (two digits), {instance} = its instance ID. */
      dnsDomainTemplate: z
        .preprocess(
          // The first default named labs after the instance ID only; slots are unique per running lab and stable per router.
          (v) => (v === 'lab{instance}.vcf.lab' ? 'lab{slot}.vcf.lab' : v),
          z
            .string()
            .regex(/^([a-z0-9{}-]+\.)*[a-z0-9{}-]+$/i, 'Use letters, digits, hyphens, dots, {slot} and {instance}')
            .refine((t) => !t.replace(/\{(slot|instance)\}/g, '').includes('{') && !t.replace(/\{(slot|instance)\}/g, '').includes('}'), 'Only {slot} and {instance} can be used as placeholders'),
        )
        .default('lab{slot}.vcf.lab'),
    })
    .prefault({}),
  /** Portal updates: where releases are published, and the daily check. */
  updates: z
    .object({
      autoCheck: z.boolean().default(true),
      /** Plain-HTTP GitLab sources (lab sites): the token then travels unencrypted. Off unless an administrator allows it. */
      allowInsecureHttp: z.boolean().default(false),
      source: z
        .discriminatedUnion('type', [
          // The public repository once published (placeholder until then: no checks).
          z.object({ type: z.literal('github'), repo: z.string().max(200).default('msteward1/holodeck-portal') }),
          z.object({ type: z.literal('gitlab'), url: z.string().url().max(300).refine((u) => /^https?:\/\//.test(u), 'http(s) only'), project: z.string().regex(/^[\w.-]+(\/[\w.-]+)+$/, 'group/project') }),
        ])
        .default({ type: 'github', repo: 'msteward1/holodeck-portal' }),
    })
    .prefault({}),
  /** Default policy for idle labs; each Holorouter can follow it, override it or opt out. Off until an admin enables it. */
  idle: z
    .object({
      suspend: idleStage.prefault({ days: 7 }),
      shutdown: idleStage.prefault({ days: 14 }),
    })
    .prefault({}),
  holorouters: z
    .object({
      /** OVA used to deploy new Holorouters; downloaded to the portal's cache, checked, then deployed. */
      ovaUrl: z
        .string()
        .trim()
        .regex(/^(https?:\/\/\S+)?$/, 'Use an http:// or https:// URL')
        .default(''),
      /** SHA-256 of the approved OVA. When set, a download that doesn't match is never deployed. */
      ovaSha256: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^([a-f0-9]{64})?$/, 'A SHA-256 is 64 hexadecimal characters')
        .default(''),
      /** Optional webtop gateway: open webtops through the portal (per router; see webtop-gateway.ts). */
      /**
       * New installations open webtops through the portal only (users are signed in automatically; routers' own web
       * ports are closed on the management network). Installations from before 0.4.6 keep what they had (migration 9).
       */
      webtopGateway: z
        .object({
          enabled: z.boolean().default(true),
          /** Mode for routers without their own choice. */
          defaultMode: z.enum(['direct', 'portal', 'portal-only']).default('portal-only'),
        })
        .default({ enabled: true, defaultMode: 'portal-only' }),
      /**
       * Router deployments verify their own vCenter sign-in against the approved vCenter's CA (vCenter targets only;
       * needs an approval that captured the CA). Off restores Holodeck's behaviour for that connection.
       */
      strictVcenterTrust: z.boolean().default(true),
      /** Also require the SHA-256 for https:// URLs (plain http:// always requires it). */
      requireOvaDigest: z.boolean().default(false),
      /** PEM CA certificate(s) for an https:// depot whose certificate isn't publicly trusted. */
      depotCaPem: z
        .string()
        .trim()
        .regex(/^(-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*)?$/, 'Paste PEM certificate(s)')
        .default(''),
      /** Webtop login shown to lab owners (the same on every Holorouter). */
      webtopUsername: z.string().default('admin'),
      webtopPort: z.number().int().min(1).max(65535).default(30000),
      /** Minutes between reachability checks of secondary Holorouters. */
      healthCheckMinutes: z.number().int().min(1).max(60).default(5),
    })
    .prefault({}),
  auth: z
    .object({
      localEnabled: z.boolean().default(true),
      oidc: z
        .object({
          enabled: z.boolean().default(false),
          displayName: z.string().default('Single Sign-On'),
          issuer: z.string().default(''),
          clientId: z.string().default(''),
          scopes: z.string().default('openid profile email groups'),
          usernameClaim: z.string().default('preferred_username'),
          groupsClaim: z.string().default('groups'),
          adminGroups: groupList,
          userGroups: groupList,
          autoProvision: z.boolean().default(true),
        })
        .prefault({}),
      saml: z
        .object({
          enabled: z.boolean().default(false),
          displayName: z.string().default('SAML Sign-On'),
          entryPoint: z.string().default(''),
          idpIssuer: z.string().default(''),
          idpCert: z.string().default(''),
          spEntityId: z.string().default(''),
          usernameAttribute: z.string().default('http://schemas.goauthentik.io/2021/02/saml/username'),
          emailAttribute: z.string().default('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'),
          firstNameAttribute: z.string().default(''),
          lastNameAttribute: z.string().default(''),
          groupsAttribute: z.string().default('http://schemas.xmlsoap.org/claims/Group'),
          adminGroups: groupList,
          userGroups: groupList,
          autoProvision: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsSection = keyof Settings;

/** Secrets kept out of the settings blob and encrypted separately. */
type SecretKey = 'oidc.clientSecret' | 'webtop.password' | 'updates.gitlabToken';

export function getSettings(): Settings {
  const rows = all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key NOT LIKE 'secret:%'");
  const raw: Record<string, unknown> = {};
  for (const r of rows) raw[r.key] = JSON.parse(r.value);
  return settingsSchema.parse(raw);
}

export function updateSettings(section: SettingsSection, value: unknown): Settings {
  const current = getSettings();
  const next = settingsSchema.parse({ ...current, [section]: value });
  if (section === 'network' && next.network.secondOctetEnd < next.network.secondOctetStart) {
    throw new Error('Network pool end must be greater than or equal to start');
  }
  if (section === 'lease' && next.lease.defaultDays > next.lease.maxDays) {
    throw new Error('Default lease cannot exceed the maximum lease');
  }
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    section,
    JSON.stringify(next[section]),
  );
  return next;
}

export function getSecret(name: SecretKey): string {
  const row = all<{ value: string }>('SELECT value FROM settings WHERE key = ?', `secret:${name}`)[0];
  return row ? decrypt<string>(row.value, '') : '';
}

export function setSecret(name: SecretKey, value: string) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    `secret:${name}`,
    encrypt(value),
  );
}
