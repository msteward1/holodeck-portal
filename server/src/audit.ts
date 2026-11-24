import { run } from './db.js';
import { getSettings } from './settings.js';

export function audit(userId: number | null, action: string, target: string | null, details?: unknown, ip?: string) {
  run(
    'INSERT INTO audit (user_id, action, target, details, ip) VALUES (?, ?, ?, ?, ?)',
    userId,
    action,
    target,
    details === undefined ? null : JSON.stringify(details),
    ip ?? null,
  );
}

export function notify(
  userId: number,
  opts: { labId?: number | null; level?: 'info' | 'warning' | 'error' | 'success'; title: string; message?: string; dedupeKey?: string },
) {
  run(
    `INSERT INTO notifications (user_id, lab_id, level, title, message, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    userId,
    opts.labId ?? null,
    opts.level ?? 'info',
    opts.title,
    opts.message ?? '',
    opts.dedupeKey ?? null,
  );
}

/** Hourly: drop audit entries past the retention period (Settings → General). */
export function pruneAudit(days = getSettings().general.auditRetentionDays) {
  run('DELETE FROM audit WHERE ts < ?', new Date(Date.now() - days * 86400_000).toISOString());
}
