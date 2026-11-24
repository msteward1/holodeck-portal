import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, get, run } from '../db.js';
import { audit } from '../audit.js';
import { requireUser } from '../auth/session.js';
import { HttpError, afterJobCancelled, getLab, type UserRow } from '../labs.js';
import { answerPrompt, cancelJob, getJob, jobView, readLog, type JobRow } from '../holodeck/jobs.js';

/**
 * Lab jobs belong to the lab's current owner: after a transfer the former owner loses access to them
 * (reads, logs, answers and cancellation alike). Jobs without a lab stay with whoever submitted them.
 */
export function canSeeJob(user: Pick<UserRow, 'id' | 'role'>, job: Pick<JobRow, 'user_id' | 'lab_id'>) {
  if (user.role === 'admin') return true;
  if (job.lab_id) return getLab(job.lab_id)?.owner_id === user.id;
  return job.user_id === user.id;
}

function jobFor(req: FastifyRequest): JobRow {
  const user = requireUser(req);
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const job = getJob(id);
  if (!job || !canSeeJob(user, job)) throw new HttpError(404, 'Job not found');
  return job;
}

export async function jobRoutes(app: FastifyInstance) {
  app.get('/api/jobs', async (req) => {
    const user = requireUser(req);
    const q = z
      .object({ labId: z.coerce.number().int().optional(), active: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (user.role !== 'admin') {
      where.push('(CASE WHEN j.lab_id IS NULL THEN j.user_id = ? ELSE l.owner_id = ? END)');
      params.push(user.id, user.id);
    }
    if (q.labId) {
      where.push('j.lab_id = ?');
      params.push(q.labId);
    }
    if (q.active === '1') where.push("j.status IN ('queued','running','waiting_input')");
    const rows = all<JobRow & { username: string | null; lab_name: string | null }>(
      `SELECT j.*, u.username, l.name AS lab_name FROM jobs j
       LEFT JOIN labs l ON l.id = j.lab_id LEFT JOIN users u ON u.id = j.user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY j.created_at DESC LIMIT ?`,
      ...params,
      q.limit,
    );
    return { jobs: rows.map((r) => ({ ...jobView(r), username: r.username, labName: r.lab_name })) };
  });

  app.get('/api/jobs/:id', async (req) => ({ job: jobView(jobFor(req)) }));

  app.get('/api/jobs/:id/log', async (req) => {
    const job = jobFor(req);
    const { offset } = z.object({ offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    return { ...readLog(job.id, offset), status: job.status, prompt: jobView(job).prompt };
  });

  app.post('/api/jobs/:id/answer', async (req) => {
    const user = requireUser(req);
    const job = jobFor(req);
    const { value } = z.object({ value: z.string().max(4000) }).parse(req.body);
    answerPrompt(job.id, value);
    audit(user.id, 'job.answer', `job:${job.id}`, { prompt: jobView(job).prompt?.prompt }, req.ip);
    return { ok: true };
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    const user = requireUser(req);
    const job = jobFor(req);
    await cancelJob(job.id);
    afterJobCancelled(job);
    audit(user.id, 'job.cancel', `job:${job.id}`, null, req.ip);
    return { job: jobView(getJob(job.id)!) };
  });
}

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/api/notifications', async (req) => {
    const user = requireUser(req);
    const items = all(
      `SELECT id, lab_id AS labId, level, title, message, created_at AS createdAt, read_at AS readAt
       FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
      user.id,
    );
    const unread = get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id)?.n ?? 0;
    return { items, unread };
  });

  app.post('/api/notifications/read', async (req) => {
    const user = requireUser(req);
    const { ids } = z.object({ ids: z.array(z.number().int()).optional() }).parse(req.body ?? {});
    if (ids?.length) {
      run(
        `UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
        user.id,
        ...ids,
      );
    } else {
      run("UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND read_at IS NULL", user.id);
    }
    return { ok: true };
  });
}
