import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth/session.js';
import { audit } from '../audit.js';
import { HttpError } from '../labs.js';
import { setSecret } from '../settings.js';
import { checkForUpdates, requestInstall, stageBundle, startDownload, updatesDir, updatesView } from '../updates.js';

const MAX_BUNDLE = 4.5 * 1024 ** 3;

/** About → Updates (administrators). */
export async function updateRoutes(app: FastifyInstance) {
  // Offline bundles are streamed to disk, never held in memory (only this plugin accepts raw uploads).
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.get('/api/admin/updates', async (req) => {
    requireAdmin(req);
    return updatesView();
  });

  app.post('/api/admin/updates/check', async (req) => {
    requireAdmin(req);
    await checkForUpdates();
    return updatesView();
  });

  app.post('/api/admin/updates/download', async (req) => {
    const admin = requireAdmin(req);
    const { install } = z.object({ install: z.boolean().default(false) }).parse(req.body ?? {});
    startDownload({ install });
    audit(admin.id, install ? 'update.install' : 'update.download', null, { version: updatesView().available?.version }, req.ip);
    return updatesView();
  });

  app.post('/api/admin/updates/install', async (req) => {
    const admin = requireAdmin(req);
    const { version } = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).parse(req.body);
    requestInstall(version);
    audit(admin.id, 'update.install', null, { version }, req.ip);
    return updatesView();
  });

  app.put('/api/admin/updates/upload', async (req) => {
    const admin = requireAdmin(req);
    if (!req.headers['content-type']?.startsWith('application/octet-stream')) throw new HttpError(415, 'Send the bundle as application/octet-stream');
    fs.mkdirSync(updatesDir(), { recursive: true, mode: 0o700 });
    const file = path.join(updatesDir(), `upload-${crypto.randomBytes(6).toString('hex')}.hpupdate`);
    let n = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _e, cb) {
        n += chunk.length;
        cb(n > MAX_BUNDLE ? new HttpError(413, 'The file is too large for an update bundle.') : null, chunk);
      },
    });
    try {
      await pipeline(req.body as Readable, limit, fs.createWriteStream(file, { mode: 0o600 }));
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
    const manifest = await stageBundle(file);
    audit(admin.id, 'update.upload', null, { version: manifest.version, sha256: manifest.image.sha256 }, req.ip);
    return updatesView();
  });

  app.put('/api/admin/settings/updates-token', async (req) => {
    const admin = requireAdmin(req);
    const { token } = z.object({ token: z.string().max(200) }).parse(req.body);
    setSecret('updates.gitlabToken', token.trim());
    audit(admin.id, 'settings.updates-token', 'settings:updates', { set: Boolean(token.trim()) }, req.ip);
    return { ok: true };
  });
}
