import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { cookieSecret } from './crypto.js';
import { HttpError } from './labs.js';
import { loadSessionUser } from './auth/session.js';
import { authRoutes } from './routes/auth.js';
import { labRoutes } from './routes/labs.js';
import { jobRoutes, notificationRoutes } from './routes/jobs.js';
import { metaRoutes } from './routes/meta.js';
import { adminRoutes } from './routes/admin.js';
import { holorouterRoutes } from './routes/holorouters.js';
import { docsRoutes } from './routes/docs.js';
import { certificateRoutes } from './routes/certificate.js';
import { updateRoutes } from './routes/updates.js';
import { webtopRoutes } from './routes/webtop.js';

/** State-changing API calls must carry this header; browsers won't add it to cross-site form posts. */
const CSRF_HEADER = 'x-holoportal';
const CSRF_EXEMPT = new Set(['/api/auth/saml/acs']);

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: '127.0.0.1',
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie, { secret: cookieSecret });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    req.user = loadSessionUser(req);
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !CSRF_EXEMPT.has(url)) {
      if (req.headers[CSRF_HEADER] !== '1') throw new HttpError(403, 'Missing request header');
    }
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: msg });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  await app.register(authRoutes);
  await app.register(labRoutes);
  await app.register(jobRoutes);
  await app.register(notificationRoutes);
  await app.register(metaRoutes);
  await app.register(adminRoutes);
  await app.register(holorouterRoutes);
  await app.register(docsRoutes);
  await app.register(certificateRoutes);
  await app.register(updateRoutes);
  await app.register(webtopRoutes);


  // Single-page app: static assets plus index.html for client-side routes.
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: false });
    const indexFile = path.join(config.webDist, 'index.html');
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      // A missing hashed asset must not get the app page back (the browser would show a blank page).
      if (req.url.startsWith('/assets/')) return reply.code(404).type('text/plain').send('Not found');
      // Anything else is an app route. Read per request so a rebuilt UI is served without a restart.
      return reply.type('text/html').header('cache-control', 'no-cache').send(fs.readFileSync(indexFile));
    });
  }

  return app;
}
