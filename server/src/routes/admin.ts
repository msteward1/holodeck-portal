import fs from 'node:fs';
import { gatewayInstalled } from '../webtop-gateway.js';
import { applyAllWebtopModes, getInventory, getRouter, knownManagementNetworks, listRouters, workbenchRouter } from '../holorouters.js';
import { putConfigFile } from '../holodeck/configstore.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, get, parseJson, run, tx } from '../db.js';
import { decrypt, encrypt, hashPassword } from '../crypto.js';
import { audit } from '../audit.js';
import { requireAdmin } from '../auth/session.js';
import { getSecret, getSettings, setSecret, settingsSchema, updateSettings, type SettingsSection } from '../settings.js';
import { describeSlot, poolGroups, poolOverview, slotCount, validatePool } from '../network.js';
import { VERSIONS, buildConfigSetParams, configSets, deployOptionsSchema } from '../holodeck/catalog.js';
import { createJob, jobView, onJobComplete } from '../holodeck/jobs.js';
import { listHoloConfigIds, readHoloConfig } from '../holodeck/files.js';
import { HttpError, activeLabCount, getConfig, holodeckEnv, syncSteps, type ConfigRow, type DepotSecret, type UserRow } from '../labs.js';
import { oidcRedirectUri, resetOidcCache, samlAcsUrl, samlEntityId } from '../auth/sso.js';
import { userView } from './auth.js';
import { config } from '../config.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const username = z.string().trim().min(2).max(64).regex(/^[\w.@-]+$/, 'Letters, digits and . _ @ - only');

function configFor(req: FastifyRequest): ConfigRow {
  const { id } = idParam.parse(req.params);
  const cfg = getConfig(id);
  if (!cfg) throw new HttpError(404, 'Configuration not found');
  return cfg;
}

function maskDepot(d: DepotSecret) {
  const mask = (v?: string) => (v ? '********' : '');
  return {
    buildToken: mask(d.buildToken),
    proxy: { ...d.proxy, password: mask(d.proxy?.password) },
    offline: { ...d.offline, password: mask(d.offline?.password) },
  };
}

/** Instances Holodeck has bound to this config on some router that aren't portal labs (from the routers' last checks). */
function unmanagedInstances(cfg: ConfigRow) {
  const out: { routerId: number; router: string; instanceId: string }[] = [];
  for (const r of listRouters()) {
    const insp = parseJson<{ configs?: { file: string; instanceId: string | null }[] }>(r.inspection, {});
    for (const c of insp.configs ?? []) {
      if (!c.instanceId || !c.file.startsWith(`${cfg.config_id}-site-a`)) continue;
      if (get("SELECT 1 FROM labs WHERE instance_id = ? AND status <> 'removed'", c.instanceId.toLowerCase())) continue;
      out.push({ routerId: r.id, router: r.name, instanceId: c.instanceId });
    }
  }
  return out;
}

function configDetail(cfg: ConfigRow) {
  return {
    id: cfg.id,
    configId: cfg.config_id,
    name: cfg.name,
    description: cfg.description,
    enabled: Boolean(cfg.enabled),
    entitleAll: Boolean(cfg.entitle_all),
    userIds: all<{ user_id: number }>('SELECT user_id FROM config_entitlements WHERE config_id = ?', cfg.id).map((r) => r.user_id),
    defaults: parseJson(cfg.defaults, {}),
    placement: parseJson(cfg.placement, {}),
    depot: maskDepot(decrypt<DepotSecret>(cfg.depot_secret, {})),
    holodeck: { a: readHoloConfig(cfg.config_id, 'a'), b: readHoloConfig(cfg.config_id, 'b') },
    targetType: configTargetType(cfg),
    unmanaged: unmanagedInstances(cfg),
    activeLabs: get<{ n: number }>("SELECT COUNT(*) AS n FROM labs WHERE config_id = ? AND status <> 'removed'", cfg.id)?.n ?? 0,
    createdAt: cfg.created_at,
    updatedAt: cfg.updated_at,
  };
}

/** vCenter or standalone ESXi host: Holodeck's recorded API type, else the last inventory read; null = not known yet. */
function configTargetType(cfg: ConfigRow): 'vcenter' | 'esxi' | null {
  const apiType = readHoloConfig(cfg.config_id, 'a').target.apiType ?? (getInventory(cfg.id) as { apiType?: string } | null)?.apiType ?? null;
  return apiType === 'HostAgent' ? 'esxi' : apiType === 'VirtualCenter' ? 'vcenter' : null;
}

/** Admin jobs that only touch Holodeck configuration import the config first. */
/**
 * Holodeck configuration work runs on a workbench router (the portal has no Holodeck): the portal's copy is pushed
 * there first, and what Holodeck wrote is read back into the portal's copy afterwards.
 */
function configJob(admin: UserRow, cfg: ConfigRow, type: string, steps: Parameters<typeof createJob>[0]['steps'], display: Record<string, unknown>, extra: Partial<Parameters<typeof createJob>[0]> = {}) {
  const router = workbenchRouter();
  return createJob({
    type,
    configId: cfg.id,
    userId: admin.id,
    routerId: router.id,
    steps: [
      ...syncSteps(cfg, router),
      { title: `Import Holodeck config ${cfg.config_id}`, command: 'HP-ImportConfig', params: { ConfigID: cfg.config_id, Site: 'a' } },
      ...steps,
      { title: `Read back Holodeck config ${cfg.config_id}`, command: 'HP-ExportConfig', params: { ConfigID: cfg.config_id }, capture: 'exported' },
    ],
    display: { config: cfg.name, router: router.name, ...display },
    ...extra,
  });
}

/** Stores what Holodeck wrote (base64 per site) as the portal's master copy. */
function storeExported(files: Record<string, string> | undefined, configId: string) {
  for (const site of ['a', 'b'] as const) {
    const b64 = files?.[site];
    if (b64) putConfigFile(configId, site, Buffer.from(b64, 'base64').toString('utf8'));
  }
}

for (const type of ['config-set', 'config-precheck']) {
  onJobComplete(type, (job, result) => {
    // Even a failed precheck may have recorded placement Holodeck chose; keep whatever was read back.
    const exported = result.exported as { configId?: string; files?: Record<string, string> } | undefined;
    if (exported?.configId) storeExported(exported.files, exported.configId);
  });
}

onJobComplete('config-new', (job, result, ok) => {
  if (!ok) return;
  const created = (result.created as { configIds?: string[]; files?: Record<string, Record<string, string>> } | undefined) ?? {};
  for (const id of created.configIds ?? []) storeExported(created.files?.[id], id);
  const display = parseJson<{ name?: string; description?: string }>(job.params, {});
  for (const id of created.configIds ?? []) {
    run(
      'INSERT INTO configs (config_id, name, description) VALUES (?, ?, ?) ON CONFLICT(config_id) DO NOTHING',
      id,
      display.name || id,
      display.description ?? '',
    );
  }
});

export async function adminRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- users

  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const rows = all<UserRow & { created_at: string; last_login_at: string | null; labs: number }>(
      `SELECT u.*, (SELECT COUNT(*) FROM labs l WHERE l.owner_id = u.id AND l.status <> 'removed') AS labs
       FROM users u ORDER BY u.username`,
    );
    return {
      users: rows.map((u) => ({
        ...userView(u),
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
        activeLabs: u.labs,
        ssoLinked: u.auth_source !== 'local' && Boolean(u.external_id),
      })),
    };
  });

  /** Forgets an SSO account's IdP identity so the next sign-in with that username links afresh. */
  app.post('/api/admin/users/:id/unlink-sso', async (req) => {
    const admin = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const user = get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!user) throw new HttpError(404, 'User not found');
    if (user.auth_source === 'local') throw new HttpError(400, 'Local accounts have no SSO identity');
    tx(() => {
      run('UPDATE users SET external_id = NULL, sso_issuer = NULL WHERE id = ?', id);
      run('DELETE FROM sessions WHERE user_id = ?', id);
    });
    audit(admin.id, 'user.sso-unlink', `user:${id}`, { source: user.auth_source, previous: user.external_id ?? null }, req.ip);
    return { ok: true };
  });

  app.post('/api/admin/users', async (req, reply) => {
    const admin = requireAdmin(req);
    const body = z
      .object({
        username,
        firstName: z.string().trim().min(1).max(60),
        lastName: z.string().trim().min(1).max(60),
        email: z.string().trim().email().optional().or(z.literal('')),
        role: z.enum(['admin', 'user']).default('user'),
        authSource: z.enum(['local', 'oidc', 'saml']).default('local'),
        password: z.string().min(10).max(500).optional(),
        labQuota: z.number().int().min(0).max(10).nullable().optional(),
      })
      .parse(req.body);
    if (body.authSource === 'local' && !body.password) throw new HttpError(400, 'A password is required for local users');
    if (get('SELECT 1 FROM users WHERE username = ?', body.username)) throw new HttpError(409, 'Username already exists');
    const res = run(
      `INSERT INTO users (username, first_name, last_name, email, role, auth_source, password_hash, lab_quota)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      body.username,
      body.firstName,
      body.lastName,
      body.email || null,
      body.role,
      body.authSource,
      body.authSource === 'local' ? await hashPassword(body.password!) : null,
      body.labQuota ?? null,
    );
    audit(admin.id, 'user.create', `user:${res.lastInsertRowid}`, { username: body.username, role: body.role, authSource: body.authSource }, req.ip);
    reply.code(201);
    return { user: userView(get<UserRow>('SELECT * FROM users WHERE id = ?', Number(res.lastInsertRowid))!) };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const user = get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!user) throw new HttpError(404, 'User not found');
    const body = z
      .object({
        firstName: z.string().trim().min(1).max(60).optional(),
        lastName: z.string().trim().min(1).max(60).optional(),
        email: z.string().trim().email().nullable().optional().or(z.literal('')),
        role: z.enum(['admin', 'user']).optional(),
        enabled: z.boolean().optional(),
        labQuota: z.number().int().min(0).max(10).nullable().optional(),
        password: z.string().min(10).max(500).optional(),
      })
      .parse(req.body);
    if (id === admin.id && (body.enabled === false || body.role === 'user')) {
      throw new HttpError(400, 'You cannot disable or demote your own account');
    }
    if (body.password && user.auth_source !== 'local') throw new HttpError(400, 'Passwords are only used by local accounts');
    tx(() => {
      if (body.firstName !== undefined) run('UPDATE users SET first_name = ? WHERE id = ?', body.firstName, id);
      if (body.lastName !== undefined) run('UPDATE users SET last_name = ? WHERE id = ?', body.lastName, id);
      if (body.email !== undefined) run('UPDATE users SET email = ? WHERE id = ?', body.email || null, id);
      if (body.role !== undefined) run('UPDATE users SET role = ? WHERE id = ?', body.role, id);
      if (body.enabled !== undefined) run('UPDATE users SET enabled = ? WHERE id = ?', body.enabled ? 1 : 0, id);
      if (body.labQuota !== undefined) run('UPDATE users SET lab_quota = ? WHERE id = ?', body.labQuota, id);
      if (body.enabled === false) run('DELETE FROM sessions WHERE user_id = ?', id);
    });
    if (body.password) {
      run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.password), id);
      run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    audit(admin.id, 'user.update', `user:${id}`, { ...body, password: body.password ? '(reset)' : undefined }, req.ip);
    return { user: userView(get<UserRow>('SELECT * FROM users WHERE id = ?', id)!) };
  });

  app.delete('/api/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = idParam.parse(req.params);
    if (id === admin.id) throw new HttpError(400, 'You cannot delete your own account');
    if (get('SELECT 1 FROM labs WHERE owner_id = ? LIMIT 1', id)) {
      throw new HttpError(409, 'This user owns labs (current or historical). Disable the account instead, or reassign the labs first.');
    }
    run('DELETE FROM users WHERE id = ?', id);
    audit(admin.id, 'user.delete', `user:${id}`, null, req.ip);
    return { ok: true };
  });

  // -------------------------------------------------------------- configs

  app.get('/api/admin/configs', async (req) => {
    requireAdmin(req);
    const rows = all<ConfigRow>('SELECT * FROM configs ORDER BY name');
    const registered = new Set(rows.map((r) => r.config_id));
    return {
      configs: rows.map(configDetail),
      unregistered: listHoloConfigIds()
        .filter((id) => !registered.has(id))
        .map((id) => readHoloConfig(id, 'a')),
    };
  });

  app.get('/api/admin/configs/:id', async (req) => {
    requireAdmin(req);
    return { config: configDetail(configFor(req)) };
  });

  app.post('/api/admin/configs/register', async (req, reply) => {
    const admin = requireAdmin(req);
    const body = z.object({ configId: z.string().regex(/^[a-z0-9]+$/i), name: z.string().trim().min(1).max(60), description: z.string().max(500).default('') }).parse(req.body);
    if (!readHoloConfig(body.configId, 'a').exists) throw new HttpError(404, `Holodeck config '${body.configId}' not found`);
    if (get('SELECT 1 FROM configs WHERE config_id = ?', body.configId)) throw new HttpError(409, 'Already registered');
    const res = run('INSERT INTO configs (config_id, name, description) VALUES (?, ?, ?)', body.configId, body.name, body.description);
    audit(admin.id, 'config.register', `config:${res.lastInsertRowid}`, body, req.ip);
    reply.code(201);
    return { config: configDetail(getConfig(Number(res.lastInsertRowid))!) };
  });

  app.post('/api/admin/configs/new', async (req) => {
    const admin = requireAdmin(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(60),
        description: z.string().max(500).default(''),
        targetHost: z.string().trim().min(1),
        username: z.string().trim().min(1),
        password: z.string().min(1),
      })
      .parse(req.body);
    const router = workbenchRouter();
    const job = createJob({
      type: 'config-new',
      userId: admin.id,
      routerId: router.id,
      steps: [
        {
          title: `Create Holodeck configuration for ${body.targetHost}`,
          command: 'HP-NewConfig',
          params: { TargetHost: body.targetHost, UserName: body.username, Password: body.password, Description: body.description || body.name },
          redact: ['Password'],
          capture: 'created',
        },
      ],
      display: { name: body.name, description: body.description, targetHost: body.targetHost, router: router.name },
    });
    audit(admin.id, 'config.create', null, { name: body.name, targetHost: body.targetHost }, req.ip);
    return { job: jobView(job) };
  });

  app.patch('/api/admin/configs/:id', async (req) => {
    const admin = requireAdmin(req);
    const cfg = configFor(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        description: z.string().max(500).optional(),
        enabled: z.boolean().optional(),
        entitleAll: z.boolean().optional(),
        userIds: z.array(z.number().int().positive()).optional(),
        defaults: deployOptionsSchema.partial().optional(),
        placement: z
          .object({ cluster: z.string().optional(), datastore: z.string().optional(), resourcePool: z.string().optional(), portGroup: z.string().optional() })
          .optional(),
      })
      .parse(req.body);
    tx(() => {
      if (body.name !== undefined) run('UPDATE configs SET name = ? WHERE id = ?', body.name, cfg.id);
      if (body.description !== undefined) run('UPDATE configs SET description = ? WHERE id = ?', body.description, cfg.id);
      if (body.enabled !== undefined) run('UPDATE configs SET enabled = ? WHERE id = ?', body.enabled ? 1 : 0, cfg.id);
      if (body.entitleAll !== undefined) run('UPDATE configs SET entitle_all = ? WHERE id = ?', body.entitleAll ? 1 : 0, cfg.id);
      if (body.defaults !== undefined) run('UPDATE configs SET defaults = ? WHERE id = ?', JSON.stringify(body.defaults), cfg.id);
      if (body.placement !== undefined) run('UPDATE configs SET placement = ? WHERE id = ?', JSON.stringify(body.placement), cfg.id);
      if (body.userIds !== undefined) {
        run('DELETE FROM config_entitlements WHERE config_id = ?', cfg.id);
        for (const uid of body.userIds) run('INSERT OR IGNORE INTO config_entitlements (config_id, user_id) VALUES (?, ?)', cfg.id, uid);
      }
      run("UPDATE configs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", cfg.id);
    });
    audit(admin.id, 'config.update', `config:${cfg.id}`, body, req.ip);
    return { config: configDetail(getConfig(cfg.id)!) };
  });

  /** Depot token, proxy and offline depot details used for unattended deployments. Blank secret fields keep the stored value. */
  app.put('/api/admin/configs/:id/depot', async (req) => {
    const admin = requireAdmin(req);
    const cfg = configFor(req);
    const str = z.string().max(4000).optional();
    const body = z
      .object({
        buildToken: str,
        proxy: z.object({ enabled: z.boolean().optional(), protocol: str, ip: str, port: str, username: str, password: str }).optional(),
        offline: z.object({ ip: str, port: str, protocol: str, username: str, password: str }).optional(),
        clear: z.array(z.enum(['buildToken', 'proxy.password', 'offline.password'])).optional(),
      })
      .parse(req.body);
    const current = decrypt<DepotSecret>(cfg.depot_secret, {});
    const keep = (next: string | undefined, prev: string | undefined) => (next && next !== '********' ? next : prev);
    const merged: DepotSecret = {
      buildToken: keep(body.buildToken, current.buildToken),
      proxy: { ...current.proxy, ...body.proxy, password: keep(body.proxy?.password, current.proxy?.password) },
      offline: { ...current.offline, ...body.offline, password: keep(body.offline?.password, current.offline?.password) },
    };
    for (const c of body.clear ?? []) {
      if (c === 'buildToken') delete merged.buildToken;
      if (c === 'proxy.password' && merged.proxy) delete merged.proxy.password;
      if (c === 'offline.password' && merged.offline) delete merged.offline.password;
    }
    run('UPDATE configs SET depot_secret = ? WHERE id = ?', encrypt(merged), cfg.id);
    audit(admin.id, 'config.depot.update', `config:${cfg.id}`, null, req.ip);
    return { config: configDetail(getConfig(cfg.id)!) };
  });

  app.post('/api/admin/configs/:id/set', async (req) => {
    const admin = requireAdmin(req);
    const cfg = configFor(req);
    const body = z.object({ set: z.string(), values: z.record(z.string(), z.unknown()), site: z.enum(['a', 'b']).default('a') }).parse(req.body);
    let built: ReturnType<typeof buildConfigSetParams>;
    try {
      built = buildConfigSetParams(body.set, body.values, body.site);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    const def = configSets.find((s) => s.id === body.set)!;
    const steps = [
      { title: `Set-HoloDeckConfig: ${def.label}`, command: 'Set-HoloDeckConfig', params: built.params, redact: built.redact },
      { title: 'Read back configuration', command: 'HP-ConfigSummary', capture: 'summary' },
    ];
    if (body.set === 'Credentials') (steps[0].params as Record<string, unknown>).ConfigID = cfg.config_id;
    const display = Object.fromEntries(Object.entries(built.params).map(([k, v]) => [k, built.redact.includes(k) ? '********' : v]));
    const job = configJob(admin, cfg, 'config-set', steps, { set: def.label, ...display });
    audit(admin.id, 'config.set', `config:${cfg.id}`, { set: body.set, values: display }, req.ip);
    return { job: jobView(job) };
  });

  app.post('/api/admin/configs/:id/precheck', async (req) => {
    const admin = requireAdmin(req);
    const cfg = configFor(req);
    const body = z
      .object({ version: z.enum(VERSIONS), vvf: z.boolean().default(false), vSANMode: z.enum(['OSA', 'ESA']).optional(), deployVcfAutomation: z.boolean().default(false) })
      .parse(req.body);
    const params: Record<string, unknown> = { Version: body.version, Site: 'a', DeveloperMode: true };
    if (body.vvf) params.VVF = true;
    if (body.vSANMode) params.vSANMode = body.vSANMode;
    if (body.deployVcfAutomation) params.DeployVcfAutomation = true;
    const job = configJob(admin, cfg, 'config-precheck', [{ title: 'Run Holodeck precheck', command: 'Start-HoloDeckPrecheck', params }], body, {
      env: holodeckEnv(cfg),
    });
    audit(admin.id, 'config.precheck', `config:${cfg.id}`, body, req.ip);
    return { job: jobView(job) };
  });

  /**
   * Removes an instance Holodeck has bound to this config on a router, which the portal doesn't manage (e.g. a manual
   * test). The router's checks list such instances.
   */
  app.post('/api/admin/configs/:id/remove-instance', async (req) => {
    const admin = requireAdmin(req);
    const cfg = configFor(req);
    const { routerId } = z.object({ routerId: z.number().int().positive() }).parse(req.body ?? {});
    const router = getRouter(routerId);
    if (!router) throw new HttpError(404, 'Holorouter not found');
    const insp = parseJson<{ configs?: { file: string; instanceId: string | null }[] }>(router.inspection, {});
    const bound = (insp.configs ?? []).find((c) => c.file.startsWith(`${cfg.config_id}-site-a`) && c.instanceId);
    const instanceId = bound?.instanceId;
    if (!instanceId) throw new HttpError(409, `No instance is bound to this configuration on ${router.name} (run Check now on the router if this is out of date).`);
    if (get("SELECT 1 FROM labs WHERE instance_id = ? AND status <> 'removed'", instanceId.toLowerCase())) {
      throw new HttpError(409, `Instance ${instanceId} belongs to a portal lab; remove it from the lab card instead`);
    }
    const job = createJob({
      type: 'config-remove-instance',
      configId: cfg.id,
      userId: admin.id,
      routerId: router.id,
      env: { ...holodeckEnv(cfg), inputInstanceId: instanceId },
      answers: [{ match: 'confirm the deletion', value: instanceId }],
      steps: [
        { title: `Import Holodeck config ${cfg.config_id}`, command: 'HP-ImportConfig', params: { ConfigID: cfg.config_id, Site: 'a' } },
        { title: `Remove instance ${instanceId}`, command: 'Remove-HoloDeckInstance', params: { site: 'a', InstanceID: instanceId } },
        { title: 'Remove leftover VMs', command: 'HP-RemoveLeftoverVMs', params: { InstanceID: instanceId, Site: 'a' } },
        { title: 'Verify removal', command: 'HP-AssertRemoved', params: { InstanceID: instanceId, Site: 'a' } },
        { title: 'Clear instance binding', command: 'HP-ClearInstanceBinding', params: { ConfigID: cfg.config_id, InstanceID: instanceId } },
      ],
      display: { config: cfg.name, router: router.name, instanceId },
    });
    audit(admin.id, 'config.remove-instance', `config:${cfg.id}`, { instanceId, router: router.name }, req.ip);
    return { job: jobView(job) };
  });

  app.delete('/api/admin/configs/:id', async (req) => {
    const admin = requireAdmin(req);
    const cfg = configFor(req);
    if (get("SELECT 1 FROM labs WHERE config_id = ? AND status <> 'removed'", cfg.id)) {
      throw new HttpError(409, 'Remove the labs deployed from this configuration first');
    }
    if (get('SELECT 1 FROM labs WHERE config_id = ?', cfg.id)) {
      // Keep history intact: disable instead of deleting.
      run('UPDATE configs SET enabled = 0 WHERE id = ?', cfg.id);
      audit(admin.id, 'config.disable', `config:${cfg.id}`, null, req.ip);
      return { ok: true, disabled: true };
    }
    run('DELETE FROM configs WHERE id = ?', cfg.id);
    audit(admin.id, 'config.unregister', `config:${cfg.id}`, null, req.ip);
    return { ok: true };
  });

  // ------------------------------------------------------------- settings

  app.get('/api/admin/settings', async (req) => {
    requireAdmin(req);
    const s = getSettings();
    return {
      settings: s,
      oidcSecretSet: Boolean(getSecret('oidc.clientSecret')),
      webtopPasswordSet: Boolean(getSecret('webtop.password')),
      updatesTokenSet: Boolean(getSecret('updates.gitlabToken')),
      sso: { oidcRedirectUri: oidcRedirectUri(), samlAcsUrl: samlAcsUrl(), samlEntityId: samlEntityId(), samlMetadataUrl: `${config.publicUrl}/api/auth/saml/metadata` },
      pool: {
        slots: poolOverview(s.network),
        skipped: poolGroups(s.network).filter((g) => g.skipped.length).map((g) => ({ cidrs: g.sites.map((x) => x.cidr), reasons: g.skipped })),
        problems: validatePool(s.network, knownManagementNetworks()),
        managementNetworks: knownManagementNetworks(),
      },
      activeLabs: activeLabCount(),
    };
  });

  app.put('/api/admin/settings/:section', async (req) => {
    const admin = requireAdmin(req);
    const { section } = z.object({ section: z.enum(Object.keys(settingsSchema.shape) as [SettingsSection, ...SettingsSection[]]) }).parse(req.params);
    if (section === 'network') {
      const candidate = settingsSchema.shape.network.parse(req.body);
      const problems = validatePool(candidate, knownManagementNetworks());
      if (problems.length) throw new HttpError(400, problems.join(' '));
      // A router keeps its slot's networks for life (Holodeck configures them once): nothing in use may move.
      const current = getSettings().network;
      for (const r of listRouters()) {
        const before = describeSlot(current, r.slot).sites.map((x) => x.cidr).join(',');
        const after = r.slot <= slotCount(candidate) ? describeSlot(candidate, r.slot).sites.map((x) => x.cidr).join(',') : 'none';
        if (before !== after) {
          throw new HttpError(409, `This change would move ${r.name}'s slot ${r.slot} from ${before} to ${after}. Detach or forget that router first, or change the settings so it keeps its networks.`);
        }
      }
      if (activeLabCount() > 0) {
        const current = getSettings().network;
        const changed = (['firstOctet', 'secondOctetStart', 'vlanMultiplier', 'sitesPerLab'] as const).some((k) => candidate[k] !== current[k]);
        if (changed) throw new HttpError(409, 'The address formula cannot change while labs are deployed (only the pool end and DNS domain template can).');
      }
    }
    if (section === 'holorouters') {
      const candidate = settingsSchema.shape.holorouters.parse(req.body);
      if (candidate.webtopGateway.enabled && !gatewayInstalled()) {
        throw new HttpError(400, 'The webtop gateway is not set up on this portal (its token file is missing; the container creates it at start).');
      }
    }
    try {
      const next = updateSettings(section, req.body);
      if (section === 'auth') resetOidcCache();
      if (section === 'holorouters') void applyAllWebtopModes().catch((err) => console.error('applying webtop modes failed', err));
      audit(admin.id, 'settings.update', `settings:${section}`, next[section], req.ip);
      return { settings: next };
    } catch (err) {
      if (err instanceof z.ZodError) throw err;
      throw new HttpError(400, (err as Error).message);
    }
  });

  app.put('/api/admin/settings/oidc-secret', async (req) => {
    const admin = requireAdmin(req);
    const { secret } = z.object({ secret: z.string().max(4000) }).parse(req.body);
    setSecret('oidc.clientSecret', secret);
    resetOidcCache();
    audit(admin.id, 'settings.oidc-secret', 'settings:auth', null, req.ip);
    return { ok: true };
  });

  // ---------------------------------------------------------------- audit

  app.get('/api/admin/audit', async (req) => {
    requireAdmin(req);
    const { limit, before } = z
      .object({ limit: z.coerce.number().int().min(1).max(1000).default(200), before: z.coerce.number().int().optional() })
      .parse(req.query);
    const rows = all<{ id: number; ts: string; user_id: number | null; username: string | null; action: string; target: string | null; details: string | null; ip: string | null }>(
      `SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id = a.user_id
       ${before ? 'WHERE a.id < ?' : ''} ORDER BY a.id DESC LIMIT ?`,
      ...(before ? [before, limit] : [limit]),
    );
    return { entries: rows.map((r) => ({ ...r, details: parseJson(r.details, null) })) };
  });
}
