import { touchLab } from '../idle.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { get, run } from '../db.js';
import { audit } from '../audit.js';
import { requireAdmin, requireUser } from '../auth/session.js';
import { getSettings } from '../settings.js';
import { describeSlot } from '../network.js';
import { eligibleRouters, getRouter, pickRouter } from '../holorouters.js';
import { dropWebtopSessions } from '../webtop-gateway.js';
import { deployOptionsSchema } from '../holodeck/catalog.js';
import {
  HttpError,
  assertIdle,
  canAccessLab,
  day2Lab,
  deployLab,
  deployPreflight,
  diagnosticsLab,
  extendLease,
  getConfig,
  getLab,
  labCredentials,
  labWebtop,
  labView,
  listLabs,
  powerLab,
  reconcileLabHosts,
  refreshLab,
  removeLab,
  retryDeploy,
  suggestedInstanceId,
  versionAvailability,
  type LabRow,
} from '../labs.js';
import { jobView } from '../holodeck/jobs.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

function labFor(req: FastifyRequest): LabRow {
  const user = requireUser(req);
  const { id } = idParam.parse(req.params);
  const lab = getLab(id);
  if (!lab || !canAccessLab(user, lab)) throw new HttpError(404, 'Lab not found');
  return lab;
}

const deployBody = z.object({
  configId: z.number().int().positive(),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).optional(),
  instanceId: z.string().max(8).optional(),
  leaseDays: z.number().int().positive().optional(),
  ownerId: z.number().int().positive().optional(),
  routerId: z.number().int().positive().optional(),
  options: deployOptionsSchema,
});

export async function labRoutes(app: FastifyInstance) {
  app.get('/api/labs', async (req) => {
    const user = requireUser(req);
    const q = z.object({ scope: z.enum(['mine', 'all']).default('mine'), removed: z.string().optional().transform((v) => v === '1' || v === 'true') }).parse(req.query);
    return { labs: listLabs(user, q.scope, q.removed) };
  });

  app.get('/api/labs/:id', async (req) => ({ lab: labView(labFor(req), { detail: true }) }));

  app.get('/api/labs/:id/credentials', async (req) => {
    const user = requireUser(req);
    const lab = labFor(req);
    audit(user.id, 'lab.credentials.view', `lab:${lab.id}`, null, req.ip);
    if (user.id === lab.owner_id) touchLab(lab.id);
    return { credentials: labCredentials(lab), webtop: labWebtop(lab) };
  });

  /**
   * Signs of use for the idle policy. "seen": the owner opened the lab page (sent once per visit, not by the page's
   * polling, so a forgotten tab doesn't keep a lab running). "keep-running": the owner or an administrator asked to
   * restart the idle clock.
   */
  app.post('/api/labs/:id/activity', async (req) => {
    const user = requireUser(req);
    const lab = labFor(req);
    const { kind } = z.object({ kind: z.enum(['seen', 'keep-running']) }).parse(req.body);
    if (kind === 'seen') {
      if (user.id === lab.owner_id) touchLab(lab.id);
    } else {
      if (user.id !== lab.owner_id && user.role !== 'admin') throw new HttpError(403, 'Only the owner or an administrator can do this');
      run("UPDATE labs SET last_activity_at = ?, idle_warned = 0 WHERE id = ?", new Date().toISOString(), lab.id);
      audit(user.id, 'lab.idle.keep-running', `lab:${lab.id}`, null, req.ip);
    }
    return { lab: labView(getLab(lab.id)!, { detail: true }) };
  });

  app.post('/api/labs/preflight', async (req) => {
    const user = requireUser(req);
    const body = z
      .object({
        configId: z.number().int().positive(),
        options: deployOptionsSchema.partial().optional(),
        ownerId: z.number().int().optional(),
        routerId: z.number().int().positive().optional(),
      })
      .parse(req.body);
    const opts = body.options?.mode && body.options.version ? (body.options as z.infer<typeof deployOptionsSchema>) : undefined;
    const isAdmin = user.role === 'admin';
    const routerId = isAdmin ? body.routerId : undefined;
    const problems = deployPreflight(user, getConfig(body.configId), opts, isAdmin ? body.ownerId : undefined, routerId);
    const cfgId = body.configId;
    const router = pickRouter(user, routerId, opts?.version, cfgId) ?? pickRouter(user, routerId, undefined, cfgId);
    return {
      ok: problems.length === 0,
      problems,
      allocation: router ? describeSlot(getSettings().network, router.slot) : null,
      router: router ? { id: router.id, name: router.name } : null,
      // Admins may pin the lab to any free router.
      routers: isAdmin ? eligibleRouters(user, undefined, cfgId).map((r) => ({ id: r.id, name: r.name, slot: r.slot })) : undefined,
      // Versions some free router (the pinned one, if any) has the installation files for.
      versionAvailability: versionAvailability(user, routerId, cfgId),
      dnsDomainTemplate: getSettings().network.dnsDomainTemplate,
      // What a blank instance ID becomes on this router's slot.
      suggestedInstanceId: router ? suggestedInstanceId(router.slot) : null,
    };
  });

  app.post('/api/labs', async (req, reply) => {
    const user = requireUser(req);
    const body = deployBody.parse(req.body);
    const lab = deployLab(user, body, req.ip);
    reply.code(201);
    return { lab: labView(lab, { detail: true }) };
  });

  app.patch('/api/labs/:id', async (req) => {
    const user = requireUser(req);
    const lab = labFor(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        description: z.string().max(500).optional(),
        ownerId: z.number().int().positive().optional(),
        /** Administrators: never suspend or shut this lab down for inactivity. */
        idleExempt: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.idleExempt !== undefined) {
      requireAdmin(req);
      run('UPDATE labs SET idle_exempt = ?, idle_warned = 0 WHERE id = ?', body.idleExempt ? 1 : 0, lab.id);
      // Leaving the exemption starts a fresh idle period rather than acting on the time spent exempt.
      if (!body.idleExempt) run('UPDATE labs SET last_activity_at = ? WHERE id = ?', new Date().toISOString(), lab.id);
    }
    if (body.ownerId !== undefined) {
      requireAdmin(req);
      if (!get('SELECT 1 FROM users WHERE id = ?', body.ownerId)) throw new HttpError(400, 'Unknown owner');
      // Jobs follow the lab's current owner; transferring mid-job would hand a prompt to someone else.
      if (body.ownerId !== lab.owner_id) {
        try {
          assertIdle(lab);
        } catch {
          throw new HttpError(409, 'The lab has a job in progress. Wait for it to finish, or cancel it, before transferring the lab.');
        }
      }
      run('UPDATE labs SET owner_id = ? WHERE id = ?', body.ownerId, lab.id);
      // The former owner's open webtop session ends with the transfer (gateway routers).
      const router = lab.holorouter_id ? getRouter(lab.holorouter_id) : undefined;
      if (router) void dropWebtopSessions(router);
    }
    if (body.name !== undefined) run('UPDATE labs SET name = ? WHERE id = ?', body.name, lab.id);
    if (body.description !== undefined) run('UPDATE labs SET description = ? WHERE id = ?', body.description, lab.id);
    audit(user.id, 'lab.update', `lab:${lab.id}`, body, req.ip);
    return { lab: labView(getLab(lab.id)!, { detail: true }) };
  });

  app.post('/api/labs/:id/power', async (req) => {
    const user = requireUser(req);
    const { action } = z.object({ action: z.enum(['stop', 'start', 'force-off', 'suspend']) }).parse(req.body);
    const lab = labFor(req);
    const job = powerLab(user, lab, action, undefined, req.ip);
    if (user.id === lab.owner_id) touchLab(lab.id);
    return { job: jobView(job) };
  });

  app.post('/api/labs/:id/refresh', async (req) => ({ job: jobView(refreshLab(requireUser(req), labFor(req), req.ip)) }));

  app.post('/api/labs/:id/retry', async (req) => ({ job: jobView(retryDeploy(requireUser(req), labFor(req), req.ip)) }));

  app.post('/api/labs/:id/day2', async (req) => {
    const body = z.object({ action: z.string(), values: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
    const user = requireUser(req);
    const lab = labFor(req);
    const job = day2Lab(user, lab, body.action, body.values, req.ip);
    if (user.id === lab.owner_id) touchLab(lab.id);
    return { job: jobView(job) };
  });

  app.post('/api/labs/:id/diagnostics', async (req) => {
    const { full } = z.object({ full: z.boolean().default(false) }).parse(req.body ?? {});
    return { job: jobView(diagnosticsLab(requireUser(req), labFor(req), full, req.ip)) };
  });

  app.post('/api/labs/:id/lease', async (req) => {
    const user = requireUser(req);
    const { days, powerOn } = z.object({ days: z.number().int().positive(), powerOn: z.boolean().default(false) }).parse(req.body);
    const lab = extendLease(user, labFor(req), days, req.ip);
    // Extending the lease says the lab is wanted.
    touchLab(lab.id);
    let job = null;
    if (powerOn && lab.status === 'ready' && ['off', 'partial'].includes(lab.power_state)) {
      job = jobView(powerLab(user, lab, 'start', 'Lease renewed', req.ip));
    }
    return { lab: labView(getLab(lab.id)!, { detail: true }), job };
  });

  app.delete('/api/labs/:id', async (req) => ({ job: jobView(removeLab(requireUser(req), labFor(req), req.ip)) }));

  /** Accept the current host list after a failed expansion that a refresh couldn't confirm. */
  app.post('/api/labs/:id/reconcile-hosts', async (req) => {
    const admin = requireAdmin(req);
    const lab = labFor(req);
    assertIdle(lab);
    reconcileLabHosts(admin, lab, req.ip);
    return { lab: labView(getLab(lab.id)!, { detail: true }) };
  });

  /** Forget a lab without touching Holodeck (admin cleanup after manual removal). */
  app.post('/api/labs/:id/forget', async (req) => {
    const admin = requireAdmin(req);
    const lab = labFor(req);
    run("UPDATE labs SET status = 'removed', removed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), credentials_enc = NULL WHERE id = ?", lab.id);
    audit(admin.id, 'lab.forget', `lab:${lab.id}`, null, req.ip);
    return { ok: true };
  });
}
