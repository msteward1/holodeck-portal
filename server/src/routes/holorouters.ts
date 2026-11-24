import { idlePolicySchema } from '../idle.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, get, run } from '../db.js';
import { audit } from '../audit.js';
import { requireAdmin } from '../auth/session.js';
import { setSecret, getSecret } from '../settings.js';
import { createJob, jobView } from '../holodeck/jobs.js';
import { parseServices, parseSubnets } from '../holodeck/files.js';
import { HttpError, getConfig, type ConfigRow } from '../labs.js';
import { fleetStaging, isPortalHost, renewHostKey, applyWebtopMode,
  checkRouter,
  deleteProfile,
  deployRouter,
  detachRouter,
  fetchVcenterCert,
  scanHostKeys,
  forgetFailedRouter,
  getInventory,
  getProfile,
  getRouter,
  importRouter,
  listRouterLogs,
  listRouters,
  portalPublicKey,
  profileView,
  readRouterFile,
  refreshInventory,
  routerStaging,
  routerView,
  saveProfile,
  stageRouter,
  unstageVersion,
  tailRouterLog,
  type ProfileRow,
  type RouterRow,
} from '../holorouters.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const ipv4 = z.string().regex(/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/, 'Enter an IPv4 address');
const hostLabel = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i, 'Letters, digits and hyphens only');
const fqdnOrIp = z.string().trim().min(1).max(253).regex(/^[a-z0-9.-]+$/i, 'Enter a hostname or IP address');
const stageVersions = z.array(z.string().regex(/^[0-9]+(\.[0-9]+)*$/)).max(20).default([]);
const domain = z.string().regex(/^([a-z0-9-]+\.)*[a-z0-9-]+$/i, 'Enter a DNS domain');

function routerFor(req: FastifyRequest): RouterRow {
  const { id } = idParam.parse(req.params);
  const router = getRouter(id);
  if (!router) throw new HttpError(404, 'Holorouter not found');
  return router;
}

const profileBody = z.object({
  name: z.string().trim().min(1).max(60),
  configId: z.number().int().positive(),
  datacenter: z.string().min(1),
  cluster: z.string().min(1),
  resourcePool: z.string().optional(),
  folder: z.string().optional(),
  datastore: z.string().min(1),
  mgmtNetwork: z.string().min(1),
  trunkA: z.string().min(1),
  trunkB: z.string().min(1),
});

export async function holorouterRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------- routers

  app.get('/api/admin/holorouters', async (req) => {
    requireAdmin(req);
    return { holorouters: listRouters().map(routerView), publicKey: portalPublicKey(), webtopPasswordSet: Boolean(getSecret('webtop.password')) };
  });

  app.get('/api/admin/holorouters/:id', async (req) => {
    requireAdmin(req);
    const router = routerFor(req);
    const ready = ['ready', 'attention'].includes(router.status);
    const [services, subA, subB, logs] = ready
      ? await Promise.all([
          readRouterFile(router, 'output/holorouter_services.yaml'),
          readRouterFile(router, 'output/network_manager_config_site_a.yaml'),
          readRouterFile(router, 'output/network_manager_config_site_b.yaml'),
          listRouterLogs(router),
        ])
      : [null, null, null, []];
    const staging = await routerStaging(router).catch(() => null);
    return {
      holorouter: { ...routerView(getRouter(router.id)!), staging },
      services: parseServices(services),
      subnets: { a: parseSubnets(subA), b: parseSubnets(subB) },
      logs,
    };
  });

  app.get('/api/admin/holorouters/:id/logs/:name', async (req, reply) => {
    requireAdmin(req);
    const router = routerFor(req);
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const { tail } = z.object({ tail: z.coerce.number().int().min(1).max(50 * 1024 * 1024).default(256 * 1024) }).parse(req.query);
    const text = await tailRouterLog(router, name, tail);
    if (text === null) throw new HttpError(404, 'Log not found');
    reply.type('text/plain; charset=utf-8');
    return text;
  });

  /** Read-only Holodeck commands and Reset-HoloDeckState, run on the chosen router. */
  app.post('/api/admin/holorouters/:id/command', async (req) => {
    const admin = requireAdmin(req);
    const router = routerFor(req);
    const body = z
      .object({
        configId: z.number().int().positive(),
        // Reset-HoloRouter is deliberately not offered: it wipes every Holorouter service and reboots the host.
        action: z.enum(['bgp', 'services', 'reset-state']),
      })
      .parse(req.body);
    const cfg = getConfig(body.configId);
    if (!cfg) throw new HttpError(404, 'Configuration not found');
    if (body.action === 'reset-state' && get("SELECT 1 FROM labs WHERE holorouter_id = ? AND status <> 'removed'", router.id)) {
      throw new HttpError(409, 'Resetting Holodeck state while this router has a lab would break it. Remove the lab first.');
    }
    const steps = {
      bgp: [{ title: 'BGP configuration', command: 'Get-HoloDeckBGPConfig', params: { Site: 'a' }, capture: 'bgp' }],
      services: [{ title: 'Holorouter services', command: 'Get-HolorouterServices', capture: 'services' }],
      'reset-state': [{ title: 'Reset Holodeck state', command: 'Reset-HoloDeckState' }],
    }[body.action];
    const job = createJob({
      type: `router-${body.action}`,
      routerId: router.id,
      configId: cfg.id,
      userId: admin.id,
      exclusive: body.action === 'reset-state',
      steps: [{ title: `Import Holodeck config ${cfg.config_id}`, command: 'HP-ImportConfig', params: { ConfigID: cfg.config_id, Site: 'a' } }, ...steps],
      display: { config: cfg.name, router: router.name, action: body.action },
    });
    audit(admin.id, `holorouter.${body.action}`, `holorouter:${router.id}`, { config: cfg.config_id }, req.ip);
    return { job: jobView(job) };
  });

  /** Installation files across all routers (what can be staged, and from where): Deploy / Import dialogs. */
  app.get('/api/admin/staging', async (req) => {
    requireAdmin(req);
    return { staging: fleetStaging() };
  });

  app.post('/api/admin/holorouters/:id/stage', async (req) => {
    const admin = requireAdmin(req);
    const router = routerFor(req);
    const { versions } = z.object({ versions: z.array(z.string().regex(/^[0-9]+(\.[0-9]+)*$/)).min(1).max(20) }).parse(req.body);
    return { job: jobView(stageRouter(admin, router, versions, req.ip)) };
  });

  app.delete('/api/admin/holorouters/:id/staging/:version', async (req) => {
    const admin = requireAdmin(req);
    const router = routerFor(req);
    const { version } = z.object({ version: z.string().regex(/^[0-9]+(\.[0-9]+)*$/) }).parse(req.params);
    return { staging: await unstageVersion(admin, router, version, req.ip) };
  });

  /** Reads the SSH host keys of an address, so the administrator can compare them with the router's console. */
  app.post('/api/admin/holorouters/scan-host-key', async (req) => {
    requireAdmin(req);
    const { address } = z.object({ address: fqdnOrIp }).parse(req.body);
    return { address, keys: await scanHostKeys(address) };
  });

  app.post('/api/admin/holorouters/import', async (req) => {
    const admin = requireAdmin(req);
    const body = z
      .object({
        address: fqdnOrIp,
        password: z.string().min(1).max(200),
        /** Optional: without a profile the router serves any configuration, with the configuration's placement. */
        profileId: z.number().int().positive().nullable().optional(),
        name: z.string().trim().max(60).optional(),
        stageVersions: stageVersions,
        // The host key fingerprint the administrator compared with the router's console.
        hostKeyFingerprint: z.string().trim().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, 'Scan and confirm the router\'s host key first'),
      })
      .parse(req.body);
    const { router, job } = importRouter(admin, body, req.ip);
    return { holorouter: routerView(router), job: jobView(job) };
  });

  app.post('/api/admin/holorouters/deploy', async (req) => {
    const admin = requireAdmin(req);
    const body = z
      .object({
        profileId: z.number().int().positive(),
        // vCenter allows spaces; / \\ % (inventory paths) and * ? [ ] (Get-VM -Name wildcards) are refused.
        vmName: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[\w.()-]+(?: [\w.()-]+)*$/, 'Letters, digits, single spaces and . - _ ( ) only'),
        hostname: hostLabel,
        ip: ipv4,
        prefix: z.number().int().min(8).max(30),
        gateway: ipv4,
        dnsServer: ipv4,
        dnsDomain: domain,
        ntpServer: fqdnOrIp,
        // Holodeck's first boot reads the OVA properties with awk and doesn't undo XML escaping.
        password: z.string().min(8).max(128).regex(/^[^&<>"']+$/, 'The root password can’t contain & < > " or \''),
        gitops: z.boolean().default(false),
        stageVersions: stageVersions,
      })
      .parse(req.body);
    const { router, job } = deployRouter(admin, body, req.ip);
    return { holorouter: routerView(router), job: jobView(job) };
  });

  app.post('/api/admin/holorouters/:id/check', async (req) => {
    const admin = requireAdmin(req);
    const router = routerFor(req);
    if (!['ready', 'attention', 'offline', 'error', 'onboarding'].includes(router.status)) {
      throw new HttpError(409, `The router is ${router.status}`);
    }
    // A failed import is retried from the check (the key was installed before inspection started).
    if (router.status === 'error') run("UPDATE holorouters SET status = 'onboarding' WHERE id = ?", router.id);
    return { job: jobView(checkRouter(admin.id, getRouter(router.id)!)) };
  });

  app.patch('/api/admin/holorouters/:id', async (req) => {
    const admin = requireAdmin(req);
    const router = routerFor(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        profileId: z.number().int().positive().optional(),
        /** null = follow the default in Settings → Holorouters. */
        webtopMode: z.enum(['direct', 'portal', 'portal-only']).nullable().optional(),
        /** Idle labs on this router: follow Settings → Leases, own stages, or never. */
        idlePolicy: idlePolicySchema.optional(),
      })
      .parse(req.body);
    if (body.idlePolicy !== undefined) {
      run('UPDATE holorouters SET idle_policy = ? WHERE id = ?', body.idlePolicy.mode === 'default' ? null : JSON.stringify(body.idlePolicy), router.id);
      // A changed policy starts a fresh idle period for the router's lab instead of acting on time already passed.
      run("UPDATE labs SET last_activity_at = ?, idle_warned = 0 WHERE holorouter_id = ? AND status <> 'removed'", new Date().toISOString(), router.id);
    }
    if (body.webtopMode !== undefined) {
      if (body.webtopMode === 'portal-only' && isPortalHost(router)) {
        throw new HttpError(400, 'This router also runs the portal, so it can’t be portal-only (that closes its port 443). Use “Through the portal”.');
      }
      run('UPDATE holorouters SET webtop_mode = ? WHERE id = ?', body.webtopMode, router.id);
      await applyWebtopMode(getRouter(router.id)!);
    }
    if (body.profileId !== undefined) {
      if (!getProfile(body.profileId)) throw new HttpError(400, 'Capacity profile not found');
      if (get("SELECT 1 FROM labs WHERE holorouter_id = ? AND status <> 'removed'", router.id)) {
        throw new HttpError(409, 'The profile cannot change while the router has a lab.');
      }
      run('UPDATE holorouters SET profile_id = ? WHERE id = ?', body.profileId, router.id);
    }
    if (body.name) {
      if (get('SELECT 1 FROM holorouters WHERE name = ? AND id <> ?', body.name, router.id)) throw new HttpError(409, 'Name already in use');
      run('UPDATE holorouters SET name = ? WHERE id = ?', body.name, router.id);
    }
    audit(admin.id, 'holorouter.update', `holorouter:${router.id}`, body, req.ip);
    return { holorouter: routerView(getRouter(router.id)!) };
  });

  app.post('/api/admin/holorouters/:id/renew-host-key', async (req) => ({ job: jobView(renewHostKey(requireAdmin(req), routerFor(req), req.ip)) }));

  app.post('/api/admin/holorouters/:id/detach', async (req) => {
    const admin = requireAdmin(req);
    const router = routerFor(req);
    const body = z.object({ deleteVm: z.boolean().default(false), confirm: z.string() }).parse(req.body);
    if (body.confirm !== router.name) throw new HttpError(400, `Type ${router.name} to confirm`);
    return { job: jobView(detachRouter(admin, router, body.deleteVm, req.ip)) };
  });

  /** Drops a router record without contacting it (failed onboarding, or a VM that is already gone). */
  app.delete('/api/admin/holorouters/:id', async (req) => {
    const admin = requireAdmin(req);
    const router = routerFor(req);
    if (!['error', 'offline', 'onboarding', 'attention'].includes(router.status)) {
      throw new HttpError(409, 'Only routers that failed onboarding or are unreachable can be forgotten; detach the others.');
    }
    forgetFailedRouter(admin, router, req.ip);
    return { ok: true };
  });

  app.put('/api/admin/settings/webtop-password', async (req) => {
    const admin = requireAdmin(req);
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body);
    setSecret('webtop.password', password);
    audit(admin.id, 'settings.webtop-password', 'settings:holorouters', null, req.ip);
    return { ok: true };
  });

  // ------------------------------------------------------------ profiles

  app.get('/api/admin/profiles', async (req) => {
    requireAdmin(req);
    return { profiles: all<ProfileRow>('SELECT * FROM capacity_profiles ORDER BY name').map(profileView) };
  });

  app.post('/api/admin/profiles', async (req, reply) => {
    const admin = requireAdmin(req);
    const p = saveProfile(admin, profileBody.parse(req.body), undefined, req.ip);
    reply.code(201);
    return { profile: profileView(p) };
  });

  app.put('/api/admin/profiles/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    return { profile: profileView(saveProfile(admin, profileBody.parse(req.body), id, req.ip)) };
  });

  /** The certificate the profile's vCenter presents now, next to the approved one. */
  app.get('/api/admin/profiles/:id/vcenter-certificate', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const p = getProfile(id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const view = profileView(p);
    if (!view.vcenter) throw new HttpError(400, 'The profile’s configuration has no vCenter');
    return { current: await fetchVcenterCert(view.vcenter), approved: view.vcenterCertificate };
  });

  app.post('/api/admin/profiles/:id/vcenter-certificate', async (req) => {
    const admin = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const { sha256 } = z.object({ sha256: z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i) }).parse(req.body);
    const p = getProfile(id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const host = profileView(p).vcenter;
    if (!host) throw new HttpError(400, 'The profile’s configuration has no vCenter');
    // Approve only what vCenter presents now, and only if it is what the administrator looked at.
    const current = await fetchVcenterCert(host);
    if (current.sha256.toUpperCase() !== sha256.toUpperCase()) throw new HttpError(409, 'vCenter now presents a different certificate; review it again.');
    run('UPDATE capacity_profiles SET vcenter_thumbprint = ? WHERE id = ?', JSON.stringify(current), id);
    audit(admin.id, 'profile.vcenter-certificate', `profile:${id}`, { host, sha256: current.sha256 }, req.ip);
    return { profile: profileView(getProfile(id)!) };
  });

  app.delete('/api/admin/profiles/:id/vcenter-certificate', async (req) => {
    const admin = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    if (!getProfile(id)) throw new HttpError(404, 'Profile not found');
    run('UPDATE capacity_profiles SET vcenter_thumbprint = NULL WHERE id = ?', id);
    audit(admin.id, 'profile.vcenter-certificate.cleared', `profile:${id}`, null, req.ip);
    return { profile: profileView(getProfile(id)!) };
  });

  app.delete('/api/admin/profiles/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    deleteProfile(admin, id, req.ip);
    return { ok: true };
  });

  // ----------------------------------------------------------- inventory

  app.get('/api/admin/inventory/:id', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    return { inventory: getInventory(id) };
  });

  app.post('/api/admin/inventory/:id/refresh', async (req) => {
    const admin = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const cfg: ConfigRow | undefined = getConfig(id);
    if (!cfg) throw new HttpError(404, 'Configuration not found');
    return { job: jobView(refreshInventory(admin, cfg.id)) };
  });
}
