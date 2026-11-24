import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import type { PoolSlot } from '../lib/types';
import { PageHeader, Spinner } from '../components/ui';

interface PoolResponse {
  settings: { firstOctet: number; secondOctetStart: number; secondOctetEnd: number; vlanMultiplier: number };
  slots: PoolSlot[];
}

export function NetworkPoolView() {
  const { data } = useApi<PoolResponse>('/api/network/pool', { interval: 15_000 });
  if (!data) return <Spinner className="mx-auto size-6" />;
  const s = data.settings;
  return (
    <div className="space-y-4">
      <p className="text-center text-sm text-slate-400">
        Each slot belongs to one Holorouter and holds one lab. It reserves two /20 networks from {s.firstOctet}.{s.secondOctetStart}.0.0 –{' '}
        {s.firstOctet}.{s.secondOctetEnd}.0.0: site A is deployed, site B is held for future dual-site labs. VLANs start at the second octet ×{' '}
        {s.vlanMultiplier}.
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.slots.map((slot) => {
          const lab = slot.lab;
          const named = lab && 'name' in lab ? lab : null;
          return (
            <div key={slot.slot} className={`panel p-4 ${lab ? 'border-accent/40' : ''}`}>
              <div className="flex items-center justify-between">
                <span className="label-caps">Slot {slot.slot}</span>
                {lab ? (
                  named ? (
                    <Link to={`/labs/${named.id}`} className="text-sm font-medium text-blue-300 hover:underline">
                      {named.name} <span className="font-mono text-xs text-slate-500">({named.instanceId})</span>
                    </Link>
                  ) : (
                    <span className="text-sm text-slate-400">In use</span>
                  )
                ) : slot.holorouter ? (
                  <span className="text-sm text-emerald-400">Available</span>
                ) : (
                  <span className="text-sm text-slate-500">No Holorouter</span>
                )}
              </div>
              {slot.holorouter?.name && (
                <div className="mt-1 text-xs text-slate-400">
                  {slot.holorouter.name}
                  {' '}· {slot.holorouter.status}
                </div>
              )}
              <div className="mt-3 space-y-1.5">
                {slot.sites.map((site) => (
                  <div key={site.site} className="flex items-center justify-between rounded-lg bg-ink-900 px-3 py-2 font-mono text-xs">
                    <span className="text-slate-400">site {site.site}</span>
                    <span className="text-slate-100">{site.cidr}</span>
                    <span className="text-slate-400">
                      VLAN {site.vlanStart}–{site.vlanEnd}
                    </span>
                    {site.reserved && <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-slate-400">reserved</span>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function NetworkPool() {
  return (
    <div>
      <PageHeader title="Network pool" subtitle="CIDR and VLAN slots assigned automatically to labs." />
      <NetworkPoolView />
    </div>
  );
}
