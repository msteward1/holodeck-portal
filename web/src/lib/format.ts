export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86400_000, 'day'],
    [3600_000, 'hour'],
    [60_000, 'minute'],
  ];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      const label = `${n} ${name}${n === 1 ? '' : 's'}`;
      return diff < 0 ? `${label} ago` : `in ${label}`;
    }
  }
  return diff < 0 ? 'just now' : 'in under a minute';
}

/** "2d 4h", "3h 12m", "8m" — compact countdown to `iso`. Negative when past. */
export function countdown(iso: string, now = Date.now()): { text: string; ms: number } {
  const ms = Date.parse(iso) - now;
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86400_000);
  const h = Math.floor((abs % 86400_000) / 3600_000);
  const m = Math.floor((abs % 3600_000) / 60_000);
  const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return { text, ms };
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function duration(startIso: string | null, endIso: string | null, now = Date.now()): string {
  if (!startIso) return '—';
  const ms = (endIso ? Date.parse(endIso) : now) - Date.parse(startIso);
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export const modeLabel: Record<string, string> = {
  VVF: 'VVF',
  ManagementOnly: 'VCF · Management only',
  FullStack: 'VCF · Full stack',
};

export const jobTypeLabel: Record<string, string> = {
  'lab-deploy': 'Deploy',
  'lab-remove': 'Remove',
  'lab-power': 'Power',
  'lab-refresh': 'Refresh',
  'lab-day2': 'Day-2',
  'lab-diagnostics': 'Diagnostics',
  'config-new': 'New configuration',
  'config-set': 'Update configuration',
  'config-precheck': 'Precheck',
  'config-remove-instance': 'Remove unmanaged instance',
  'router-bgp': 'BGP config',
  'router-services': 'Holorouter services',
  'router-reset-state': 'Reset Holodeck state',
  'router-onboard': 'Import Holorouter',
  'router-deploy': 'Deploy Holorouter',
  'router-check': 'Check Holorouter',
  'router-rekey': 'Renew SSH host key',
  'router-stage': 'Stage installation files',
  'router-detach': 'Detach Holorouter',
  'router-delete': 'Delete Holorouter',
  'vcenter-inventory': 'Read vCenter inventory',
};

export function initials(first?: string, last?: string, fallback = '?') {
  const s = `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase();
  return s || fallback.slice(0, 1).toUpperCase();
}
