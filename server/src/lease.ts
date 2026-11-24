import { checkIdleLabs } from './idle.js';
import { all, get, run } from './db.js';
import { durationMs, getSettings } from './settings.js';
import { notify } from './audit.js';
import { activeJobFor, powerLab, type LabRow, type UserRow } from './labs.js';

function formatLead(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

function admins(): number[] {
  return all<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND enabled = 1").map((r) => r.id);
}

/**
 * Lease policy: two in-portal warnings at admin-set lead times, then on expiry the lab is
 * powered off (never deleted). Administrators renew or remove expired labs.
 */
export function checkLeases(now = Date.now()) {
  const s = getSettings().lease;
  const leads = [durationMs(s.firstWarning), durationMs(s.secondWarning)].sort((a, b) => b - a);
  const labs = all<LabRow>("SELECT * FROM labs WHERE status IN ('queued','deploying','ready','failed')");

  for (const lab of labs) {
    const expires = Date.parse(lab.lease_expires_at);
    const remaining = expires - now;

    if (remaining <= 0) {
      if (!lab.lease_expired) {
        run('UPDATE labs SET lease_expired = 1, warned_level = 2 WHERE id = ?', lab.id);
        const msg = `The lease for ${lab.name} (${lab.instance_id}) expired. The lab is being powered off; an administrator can renew or remove it.`;
        notify(lab.owner_id, { labId: lab.id, level: 'error', title: `${lab.name}: lease expired`, message: msg, dedupeKey: `lease-expired:${lab.id}:${lab.lease_expires_at}` });
        for (const a of admins()) {
          if (a !== lab.owner_id) {
            notify(a, { labId: lab.id, level: 'warning', title: `Lease expired: ${lab.name}`, message: msg, dedupeKey: `lease-expired:${lab.id}:${lab.lease_expires_at}` });
          }
        }
      }
      // Power off once the lab is idle and running. Deployments in progress finish first.
      if (lab.status === 'ready' && !['off', 'absent', 'stopping', 'suspended', 'suspending'].includes(lab.power_state) && !activeJobFor(lab.id)) {
        const system = get<UserRow>("SELECT * FROM users WHERE role = 'admin' AND enabled = 1 ORDER BY id LIMIT 1");
        if (system) {
          try {
            powerLab(system, lab, 'stop', 'Lease expired');
          } catch (err) {
            console.error(`lease power-off for lab ${lab.id} failed`, err);
          }
        }
      }
      continue;
    }

    // One notification per threshold crossed; a short lease that starts inside both windows warns once.
    const level = leads.filter((lead) => remaining <= lead).length;
    if (level > lab.warned_level) {
      run('UPDATE labs SET warned_level = ? WHERE id = ?', level, lab.id);
      notify(lab.owner_id, {
        labId: lab.id,
        level: 'warning',
        title: `${lab.name}: lease ends in ${formatLead(remaining)}`,
        message: `The lab will be powered off at ${new Date(expires).toUTCString()} unless the lease is extended.`,
        dedupeKey: `lease-warn${level}:${lab.id}:${lab.lease_expires_at}`,
      });
    }
  }
}

let timer: NodeJS.Timeout | null = null;
export function startLeaseLoop() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      checkLeases();
    } catch (err) {
      console.error('lease check failed', err);
    }
    try {
      checkIdleLabs();
    } catch (err) {
      console.error('idle check failed', err);
    }
  }, 60_000);
  setTimeout(() => checkLeases(), 5_000);
}
