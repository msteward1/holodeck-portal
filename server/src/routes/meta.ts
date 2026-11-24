import { z } from 'zod';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { APP_COMMIT, APP_VERSION, COPYRIGHT, FORM_FACTOR, NOTICES_FILE, REPOSITORY_URL } from '../config.js';
import { all, get, parseJson, run } from '../db.js';
import { requireUser } from '../auth/session.js';
import { getSecret, getSettings } from '../settings.js';
import { poolOverview, slotCount } from '../network.js';
import { MODES, VERSIONS, configSets, day2ActionsFor, deployFields } from '../holodeck/catalog.js';
import { readHoloConfig } from '../holodeck/files.js';
import { activeLabCount, effectiveCapacity, isEntitled, userQuota, type ConfigRow, type UserRow } from '../labs.js';
import { listRouters, pickRouter, routerServesConfig, usableRouterCount } from '../holorouters.js';
import { powerCliStatus } from '../powercli.js';

const NOTICE_IDS = ['webtop-gateway-default', 'powercli'] as const;

/**
 * Dashboard notices. Administrators: while new routers default to "through the portal only", say what that means
 * (and that it needs the webtop password). Users get none: for them the gateway only makes access simpler.
 */
export function noticesFor(user: UserRow) {
  if (user.role !== 'admin') return [];
  const dismissed = new Set(parseJson<string[]>(user.dismissed_notices ?? null, []));
  const gw = getSettings().holorouters.webtopGateway;
  const notices: { id: (typeof NOTICE_IDS)[number]; title: string; message: string; warning?: string }[] = [];
  // Not dismissible for good: it goes away once PowerCLI is installed.
  const pc = powerCliStatus();
  if (pc && pc.state === 'failed') {
    notices.push({
      id: 'powercli',
      title: 'VMware PowerCLI could not be downloaded',
      message: `The portal downloads PowerCLI ${pc.version} from the PowerShell Gallery on first start (it isn't shipped with the portal). Until then it can't read vCenter inventory or deploy and delete Holorouters; everything else works. It retries every 10 minutes. ${pc.message}`,
      warning: 'Without internet access, copy the modules in by hand: see the operations guide, Install the appliance.',
    });
  }
  if (gw.enabled && gw.defaultMode === 'portal-only' && !dismissed.has('webtop-gateway-default')) {
    notices.push({
      id: 'webtop-gateway-default',
      title: 'Webtops open through the portal only',
      message:
        "Holorouters without their own setting open their webtop through the portal: users are signed in automatically, and the router's own web ports (80, 443, 30000, 30001) are closed on the management network. Change this in Settings → Holorouters, or per router.",
      ...(getSecret('webtop.password') ? {} : { warning: 'Set the webtop password in Settings → Holorouters: without it the portal cannot sign users in to their webtop.' }),
    });
  }
  return notices;
}

function configCard(c: ConfigRow) {
  const holo = readHoloConfig(c.config_id, 'a');
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    configId: c.config_id,
    defaults: parseJson(c.defaults, {}),
    target: { hostname: holo.target.hostname, cluster: holo.target.cluster, datastore: holo.target.datastore },
    version: holo.version,
  };
}

export async function metaRoutes(app: FastifyInstance) {
  /** Liveness for container health checks and the updater: the database answers. No sign-in, no details. */
  app.get('/api/health', async (_req, reply) => {
    try {
      get('SELECT 1');
      return { ok: true, version: APP_VERSION };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  /** The About dialog. Build details are for administrators only. */
  app.get('/api/about', async (req) => {
    const user = requireUser(req);
    const about: Record<string, unknown> = {
      product: 'Holodeck Portal',
      version: APP_VERSION,
      repository: REPOSITORY_URL,
      license: 'Apache-2.0',
      copyright: COPYRIGHT,
      notices: Boolean(NOTICES_FILE),
      disclaimer: 'A community project. Not an official Broadcom or VMware product, and not supported by Broadcom.',
    };
    if (user.role === 'admin') {
      const rows = all<{ holodeck_version: string | null; n: number }>(
        "SELECT holodeck_version, COUNT(*) n FROM holorouters WHERE holodeck_version IS NOT NULL GROUP BY holodeck_version ORDER BY holodeck_version",
      );
      about.build = { commit: APP_COMMIT, formFactor: FORM_FACTOR, node: process.version, powercli: powerCliStatus() };
      about.holodeckVersions = rows.map((r) => ({ version: r.holodeck_version, routers: r.n }));
    }
    return about;
  });

  /** The open-source components the portal ships, as plain text. */
  app.get('/api/about/notices', async (req, reply) => {
    requireUser(req);
    if (!NOTICES_FILE) return reply.code(404).send({ error: 'No third-party notices in this build' });
    return reply.type('text/plain; charset=utf-8').header('cache-control', 'no-store').send(fs.readFileSync(NOTICES_FILE, 'utf8'));
  });

  app.get('/api/meta', async (req) => {
    const user = requireUser(req);
    const s = getSettings();
    return {
      versions: VERSIONS,
      modes: MODES,
      deployFields,
      day2Actions: day2ActionsFor(s.hosts),
      configSets: user.role === 'admin' ? configSets : [],
      lease: { defaultDays: s.lease.defaultDays, maxDays: s.lease.maxDays, usersCanExtend: s.lease.usersCanExtend },
      portalName: s.general.portalName,
      notices: noticesFor(user),
    };
  });

  /** "Don't show again" for a dashboard notice (dismissing for this session is kept in the browser). */
  app.post('/api/notices/:id/dismiss', async (req) => {
    const user = requireUser(req);
    const { id } = z.object({ id: z.enum(NOTICE_IDS) }).parse(req.params);
    const ids = new Set(parseJson<string[]>(user.dismissed_notices ?? null, []));
    ids.add(id);
    run('UPDATE users SET dismissed_notices = ? WHERE id = ?', JSON.stringify([...ids]), user.id);
    return { ok: true };
  });

  /** Configurations the current user may deploy from. */
  app.get('/api/configs', async (req) => {
    const user = requireUser(req);
    const rows = all<ConfigRow>('SELECT * FROM configs WHERE enabled = 1 ORDER BY name');
    const routers = listRouters();
    // Whether a Holorouter can take a lab of this configuration: 'available', 'busy' (all of its routers are in use or
    // unhealthy) or 'unmapped' (no router serves it). Users don't see unmapped configurations; administrators do.
    const availability = (c: ConfigRow) =>
      pickRouter(user, undefined, undefined, c.id) ? 'available' : routers.some((r) => routerServesConfig(r, c.id)) ? 'busy' : 'unmapped';
    return {
      configs: rows
        .filter((c) => isEntitled(user, c))
        .map((c) => ({ c, availability: availability(c) }))
        .filter(({ availability: a }) => a !== 'unmapped' || user.role === 'admin')
        .map(({ c, availability: a }) => ({ ...configCard(c), availability: a }))
    };
  });

  app.get('/api/dashboard', async (req) => {
    const user = requireUser(req);
    const s = getSettings();
    const leadMs = Math.max(
      s.lease.firstWarning.value * (s.lease.firstWarning.unit === 'days' ? 24 : 1),
      s.lease.secondWarning.value * (s.lease.secondWarning.unit === 'days' ? 24 : 1),
    ) * 3600_000;
    const soon = new Date(Date.now() + leadMs).toISOString();
    const mineOnly = user.role !== 'admin';
    const scope = mineOnly ? 'AND owner_id = ?' : '';
    const args = mineOnly ? [user.id] : [];
    const count = (where: string, ...extra: (string | number)[]) =>
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM labs WHERE ${where} ${scope}`, ...extra, ...args)?.n ?? 0;
    return {
      labs: {
        active: count("status <> 'removed'"),
        ready: count("status = 'ready'"),
        poweredOn: count("status = 'ready' AND power_state = 'on'"),
        deploying: count("status IN ('queued','deploying')"),
        failed: count("status = 'failed'"),
        expiringSoon: count("status <> 'removed' AND lease_expired = 0 AND lease_expires_at <= ?", soon),
        expired: count("status <> 'removed' AND lease_expired = 1"),
      },
      capacity: {
        used: activeLabCount(),
        max: effectiveCapacity(),
        slots: slotCount(s.network),
        configuredMax: s.capacity.maxActiveLabs,
        holorouters: usableRouterCount(),
      },
      quota: { used: activeLabCount(user.id), max: userQuota(user) },
      jobs: {
        running: get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('running','waiting_input')")?.n ?? 0,
        waitingInput: get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM jobs j LEFT JOIN labs l ON l.id = j.lab_id WHERE j.status = 'waiting_input' ${mineOnly ? 'AND (j.user_id = ? OR l.owner_id = ?)' : ''}`,
          ...(mineOnly ? [user.id, user.id] : []),
        )?.n ?? 0,
      },
    };
  });

  /** CIDR/VLAN slot usage. Users see which slots are taken but only the names of their own labs. */
  app.get('/api/network/pool', async (req) => {
    const user = requireUser(req);
    const net = getSettings().network;
    const owners = new Map(all<{ id: number; owner_id: number }>("SELECT id, owner_id FROM labs WHERE status <> 'removed'").map((r) => [r.id, r.owner_id]));
    return {
      settings: net,
      slots: poolOverview(net).map((s) => ({
        ...s,
        lab: s.lab && (user.role === 'admin' || owners.get(s.lab.id) === user.id) ? s.lab : s.lab ? { inUse: true } : null,
        holorouter: user.role === 'admin' ? s.holorouter : s.holorouter ? { status: s.holorouter.status } : null,
      })),
    };
  });
}
