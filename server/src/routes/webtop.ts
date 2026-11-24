import type { FastifyInstance } from 'fastify';
import { get } from '../db.js';
import { touchRouterLab } from '../idle.js';
import { getRouter, type RouterRow } from '../holorouters.js';
import { effectiveWebtopMode, GATEWAY_BASE_PORT, GATEWAY_MAX_SLOT, tokenMatches, upstreamPort, webtopAuthorization } from '../webtop-gateway.js';

/**
 * nginx's auth_request for the webtop gateway (see webtop-gateway.ts). Only nginx can call it usefully: it must
 * present the gateway token, and nginx refuses the path from clients. Answers 204 with the upstream port and the
 * webtop's Basic-auth header, 401 when not signed in, 403 otherwise (auth_request understands only 2xx, 401 and 403).
 */
export async function webtopRoutes(app: FastifyInstance) {
  app.get('/api/webtop/authorize', async (req, reply) => {
    if (!tokenMatches(String(req.headers['x-hp-gateway-token'] ?? ''))) return reply.code(403).send();
    const port = Number(req.headers['x-hp-gateway-port']);
    const slot = port - GATEWAY_BASE_PORT;
    if (!Number.isInteger(slot) || slot < 1 || slot > GATEWAY_MAX_SLOT) return reply.code(403).send();
    const row = get<{ id: number }>("SELECT id FROM holorouters WHERE slot = ? AND status NOT IN ('removing')", slot);
    const router: RouterRow | undefined = row ? getRouter(row.id) : undefined;
    if (!router || effectiveWebtopMode(router) === 'direct') return reply.code(403).send();
    const user = req.user;
    if (!user) return reply.code(401).send();
    const owns = get("SELECT 1 FROM labs WHERE holorouter_id = ? AND owner_id = ? AND status <> 'removed'", router.id, user.id);
    if (user.role !== 'admin' && !owns) return reply.code(403).send();
    const auth = webtopAuthorization();
    if (!auth) return reply.code(503).send();
    // Using the webtop is using the lab (idle policy).
    touchRouterLab(router.id);
    return reply
      .code(204)
      .header('cache-control', 'no-store')
      .header('x-webtop-upstream-port', String(upstreamPort(router)))
      .header('x-webtop-authorization', auth)
      .send();
  });
}
