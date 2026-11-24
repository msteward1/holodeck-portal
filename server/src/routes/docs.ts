import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAdmin, requireUser } from '../auth/session.js';
import { HttpError } from '../labs.js';

/**
 * The user and administrator guides: standalone HTML files in the repository's docs/ folder.
 * The Documentation tab reads their sections; opened directly they work as single pages.
 * The administrator and the installation & operations guides are only served to administrators.
 */
const GUIDES = {
  user: { file: 'HOLODECK_PORTAL_USER_GUIDE.html', title: 'User guide', admin: false },
  admin: { file: 'HOLODECK_PORTAL_ADMIN_GUIDE.html', title: 'Administrator guide', admin: true },
  ops: { file: 'HOLODECK_PORTAL_OPERATIONS_GUIDE.html', title: 'Installation & operations', admin: true },
} as const;
type GuideId = keyof typeof GUIDES;

export async function docsRoutes(app: FastifyInstance) {
  app.get('/api/docs', async (req) => {
    const user = requireUser(req);
    return {
      guides: (Object.keys(GUIDES) as GuideId[])
        .filter((id) => !GUIDES[id].admin || user.role === 'admin')
        .filter((id) => fs.existsSync(path.join(config.docsDir, GUIDES[id].file)))
        .map((id) => ({ id, title: GUIDES[id].title })),
    };
  });

  app.get('/api/docs/:guide', async (req, reply) => {
    const { guide } = z.object({ guide: z.enum(['user', 'admin', 'ops']) }).parse(req.params);
    if (GUIDES[guide].admin) requireAdmin(req);
    else requireUser(req);
    let html: string;
    try {
      html = fs.readFileSync(path.join(config.docsDir, GUIDES[guide].file), 'utf8');
    } catch {
      throw new HttpError(404, 'Guide not found');
    }
    // Opened in its own tab the guide is a normal page; it never needs to be framed.
    reply.type('text/html; charset=utf-8');
    return html;
  });
}
