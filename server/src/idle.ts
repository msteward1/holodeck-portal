/**
 * Idle labs: after N days without any sign of use a lab is suspended, after M days shut down (each stage optional).
 * The owner is warned before each stage. Signs of use: the owner opening the lab in the portal, viewing credentials,
 * running lab actions, extending the lease or pressing "Keep running"; webtop sessions through the gateway; and
 * webtop connections with recent traffic, counted on the lab's Holorouter at every health check.
 */
import { z } from 'zod';
import { all, get, run } from './db.js';
import { audit, notify } from './audit.js';
import { getSettings, idleStage, type IdleStage } from './settings.js';
import { activeJobFor, powerLab, type LabRow, type UserRow } from './labs.js';
import type { RouterRow } from './holorouters.js';

const DAY = 24 * 3600_000;

export const idlePolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('default') }),
  z.object({ mode: z.literal('off') }),
  z.object({ mode: z.literal('custom'), suspend: idleStage, shutdown: idleStage }),
]);
export type IdlePolicy = z.infer<typeof idlePolicySchema>;

export function routerIdlePolicy(router: Pick<RouterRow, 'idle_policy'> | null | undefined): IdlePolicy {
  if (!router?.idle_policy) return { mode: 'default' };
  const parsed = idlePolicySchema.safeParse(JSON.parse(router.idle_policy));
  return parsed.success ? parsed.data : { mode: 'default' };
}

/** The stages that apply to labs on this router. */
export function effectiveIdlePolicy(router: Pick<RouterRow, 'idle_policy'> | null | undefined): { suspend: IdleStage; shutdown: IdleStage; source: IdlePolicy['mode'] } {
  const p = routerIdlePolicy(router);
  if (p.mode === 'off') return { suspend: { enabled: false, days: 7 }, shutdown: { enabled: false, days: 14 }, source: 'off' };
  if (p.mode === 'custom') return { suspend: p.suspend, shutdown: p.shutdown, source: 'custom' };
  const d = getSettings().idle;
  return { suspend: d.suspend, shutdown: d.shutdown, source: 'default' };
}

/** A sign of use: restart the idle clock and clear the warnings (written at most once a minute per lab). */
export function touchLab(labId: number, now = Date.now()) {
  run(
    "UPDATE labs SET last_activity_at = ?, idle_warned = 0 WHERE id = ? AND status <> 'removed' AND (last_activity_at IS NULL OR last_activity_at < ? OR idle_warned <> 0)",
    new Date(now).toISOString(),
    labId,
    new Date(now - 60_000).toISOString(),
  );
}

/** Webtop use counted on a router: the lab on it is in use. */
export function touchRouterLab(routerId: number) {
  const lab = get<{ id: number }>("SELECT id FROM labs WHERE holorouter_id = ? AND status <> 'removed'", routerId);
  if (lab) touchLab(lab.id);
}

/** Counts webtop connections (NodePorts 30000/30001) that carried traffic in the last 15 minutes. */
export const WEBTOP_ACTIVITY_COMMAND =
  'T=$(cat /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established 2>/dev/null || echo 432000); ' +
  'for p in 30000 30001; do conntrack -L -p tcp --orig-port-dst $p --state ESTABLISHED 2>/dev/null; done | ' +
  'awk -v min=$((T - 900)) \'$3 >= min\' | wc -l';

export function lastActivity(lab: Pick<LabRow, 'last_activity_at' | 'created_at'>): number {
  return Date.parse(lab.last_activity_at ?? lab.created_at);
}

/** How far before a stage the owner is warned: a day, or half the stage for very short ones. */
const leadFor = (stage: IdleStage) => Math.min(DAY, (stage.days * DAY) / 2);

/** Where a lab stands: idle time and the next automatic action, for the lab page. */
export function idleStatus(lab: LabRow, router: Pick<RouterRow, 'idle_policy'> | null | undefined, now = Date.now()) {
  const policy = effectiveIdlePolicy(router);
  const idleMs = Math.max(0, now - lastActivity(lab));
  const stages = (['suspend', 'shutdown'] as const)
    .filter((k) => policy[k].enabled)
    .map((k) => ({ action: k, at: lastActivity(lab) + policy[k].days * DAY }))
    .sort((a, b) => a.at - b.at);
  const applies = (a: 'suspend' | 'shutdown') =>
    a === 'suspend' ? !['off', 'absent', 'suspended', 'suspending', 'stopping'].includes(lab.power_state) : !['off', 'absent', 'stopping'].includes(lab.power_state);
  const next = lab.idle_exempt ? null : stages.find((s) => applies(s.action)) ?? null;
  return {
    enabled: !lab.idle_exempt && (policy.suspend.enabled || policy.shutdown.enabled),
    exempt: Boolean(lab.idle_exempt),
    policy: { suspend: policy.suspend, shutdown: policy.shutdown, source: policy.source },
    lastActivityAt: new Date(lastActivity(lab)).toISOString(),
    idleDays: Math.floor(idleMs / DAY),
    next: next ? { action: next.action, at: new Date(next.at).toISOString() } : null,
  };
}

function systemAdmin() {
  return get<UserRow>("SELECT * FROM users WHERE role = 'admin' AND enabled = 1 ORDER BY id LIMIT 1");
}

/** Runs with the lease loop (every minute). */
export function checkIdleLabs(now = Date.now()) {
  const labs = all<LabRow>("SELECT * FROM labs WHERE status = 'ready' AND idle_exempt = 0 AND lease_expired = 0");
  for (const lab of labs) {
    const router = lab.holorouter_id ? get<RouterRow>('SELECT * FROM holorouters WHERE id = ?', lab.holorouter_id) : null;
    const policy = effectiveIdlePolicy(router);
    const idle = now - lastActivity(lab);
    const days = Math.floor(idle / DAY);
    const running = !['off', 'absent', 'suspended', 'suspending', 'stopping', 'starting'].includes(lab.power_state);
    const suspended = lab.power_state === 'suspended';
    const sd = policy.shutdown;
    const ss = policy.suspend;
    // Shutdown first: it also covers a running lab whose suspend stage is later or off.
    if (sd.enabled && (running || suspended)) {
      if (idle >= sd.days * DAY) {
        if (activeJobFor(lab.id)) continue;
        act(lab, 'shutdown', days);
        continue;
      }
      if (idle >= sd.days * DAY - leadFor(sd) && !(lab.idle_warned & 2)) {
        warn(lab, 'shut down', new Date(lastActivity(lab) + sd.days * DAY), 2);
      }
    }
    if (ss.enabled && running && !(sd.enabled && sd.days <= ss.days)) {
      if (idle >= ss.days * DAY) {
        if (activeJobFor(lab.id)) continue;
        act(lab, 'suspend', days);
        continue;
      }
      if (idle >= ss.days * DAY - leadFor(ss) && !(lab.idle_warned & 1)) {
        warn(lab, 'suspended', new Date(lastActivity(lab) + ss.days * DAY), 1);
      }
    }
  }
}

function warn(lab: LabRow, what: string, at: Date, bit: number) {
  run('UPDATE labs SET idle_warned = idle_warned | ? WHERE id = ?', bit, lab.id);
  notify(lab.owner_id, {
    labId: lab.id,
    level: 'warning',
    title: `${lab.name} will be ${what} for inactivity`,
    message: `No use of the lab has been seen since ${new Date(lastActivity(lab)).toUTCString()}. It will be ${what} at ${at.toUTCString()}. Open the lab and choose Keep running to prevent this.`,
    dedupeKey: `idle-${bit}:${lab.id}:${lab.last_activity_at ?? ''}`,
  });
}

function act(lab: LabRow, stage: 'suspend' | 'shutdown', days: number) {
  const admin = systemAdmin();
  if (!admin) return;
  const reason = `Idle for ${days} day${days === 1 ? '' : 's'}`;
  try {
    // Holodeck's shutdown signs in to the nested hosts, so a suspended lab is resumed first (same job).
    powerLab(admin, lab, stage === 'suspend' ? 'suspend' : 'idle-stop', reason);
  } catch (err) {
    console.error(`idle ${stage} of lab ${lab.id} failed`, err);
    return;
  }
  audit(null, `lab.idle.${stage}`, `lab:${lab.id}`, { idleDays: days });
  const verb = stage === 'suspend' ? 'suspended' : 'shut down';
  notify(lab.owner_id, {
    labId: lab.id,
    level: 'info',
    title: `${lab.name} was ${verb} for inactivity`,
    message: `${reason}. ${stage === 'suspend' ? 'Resume it from the lab page when you need it.' : 'Power it on from the lab page when you need it.'}`,
    dedupeKey: `idle-act-${stage}:${lab.id}:${lab.last_activity_at ?? ''}`,
  });
}
