import { Notices } from '../components/Notices';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, FlaskConical, Gauge, Plus, Timer } from 'lucide-react';
import { useApp } from '../lib/app-context';
import { useApi } from '../lib/hooks';
import type { Dashboard as DashboardData, Lab } from '../lib/types';
import { LabCard } from '../components/LabCard';
import { EmptyState, InfoNote, Spinner, StatTile, Tabs, Toggle } from '../components/ui';
import { ActivityList } from './Activity';
import { NetworkPoolView } from './NetworkPool';

type Tab = 'mine' | 'all' | 'activity' | 'network';

export function Dashboard() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'mine';
  const setTab = (t: Tab) => setParams(t === 'mine' ? {} : { tab: t }, { replace: true });
  const stats = useApi<DashboardData>('/api/dashboard', { interval: 10_000 });
  const d = stats.data;

  return (
    <div>
      <Notices />
      <div className="flex flex-wrap justify-center gap-4">
        <StatTile
          icon={<FlaskConical className="size-4 text-blue-300" />}
          tint="bg-blue-500/15"
          label={isAdmin ? 'Labs deployed' : 'My labs'}
          value={d?.labs.active ?? '–'}
          sub={d ? `${d.labs.poweredOn} powered on` : undefined}
          subTone="good"
        />
        <StatTile
          icon={<Gauge className="size-4 text-emerald-300" />}
          tint="bg-emerald-500/15"
          label="Capacity"
          value={d ? `${d.capacity.used}/${d.capacity.max}` : '–'}
          sub={d ? `Quota ${d.quota.used} of ${d.quota.max} used` : undefined}
        />
        <StatTile
          icon={<Timer className="size-4 text-amber-300" />}
          tint="bg-amber-500/15"
          label="Leases expiring"
          value={d?.labs.expiringSoon ?? '–'}
          sub={d ? (d.labs.expired ? `${d.labs.expired} expired` : 'None expired') : undefined}
          subTone={d?.labs.expired ? 'bad' : 'muted'}
        />
        <StatTile
          icon={d?.jobs.waitingInput ? <AlertTriangle className="size-4 text-red-300" /> : <CheckCircle2 className="size-4 text-sky-300" />}
          tint={d?.jobs.waitingInput ? 'bg-red-500/15' : 'bg-sky-500/15'}
          label="Jobs running"
          value={d?.jobs.running ?? '–'}
          sub={d ? (d.jobs.waitingInput ? `${d.jobs.waitingInput} waiting for input` : 'Nothing needs attention') : undefined}
          subTone={d?.jobs.waitingInput ? 'warn' : 'muted'}
        />
      </div>

      <div className="mt-10">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'mine', label: 'My Labs' },
            ...(isAdmin ? [{ id: 'all' as Tab, label: 'All Labs' }] : []),
            { id: 'activity', label: 'Activity' },
            { id: 'network', label: 'Network' },
          ]}
        />
      </div>

      <div className="mt-8">
        {tab === 'mine' && <LabGrid scope="mine" onChanged={stats.reload} />}
        {tab === 'all' && isAdmin && <LabGrid scope="all" onChanged={stats.reload} showOwner />}
        {tab === 'activity' && <ActivityList />}
        {tab === 'network' && <NetworkPoolView />}
      </div>
    </div>
  );
}

export function LabGrid({ scope, onChanged, showOwner }: { scope: 'mine' | 'all'; onChanged?: () => void; showOwner?: boolean }) {
  const [showRemoved, setShowRemoved] = useState(false);
  const labs = useApi<{ labs: Lab[] }>(`/api/labs?scope=${scope}${showRemoved ? '&removed=1' : ''}`, { interval: 8000 });
  const reload = () => {
    void labs.reload();
    onChanged?.();
  };
  if (labs.loading && !labs.data) return <Spinner className="mx-auto size-6" />;
  if (labs.error) return <InfoNote tone="warn">{labs.error}</InfoNote>;
  const list = labs.data?.labs ?? [];
  return (
    <div className="space-y-4">
      {scope === 'all' && (
        <div className="flex justify-end">
          <Toggle checked={showRemoved} onChange={setShowRemoved} label="Show removed labs" />
        </div>
      )}
      {list.length === 0 ? (
        <EmptyState icon={<FlaskConical className="size-6" />} title={scope === 'mine' ? 'You have no labs yet' : 'No labs deployed'}>
          <p>Deploy a nested VCF or VVF lab from one of the configurations your administrator has published.</p>
          <Link to="/labs/new" className="btn-primary mt-4">
            <Plus className="size-4" /> Deploy a lab
          </Link>
        </EmptyState>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 2xl:grid-cols-3">
          {list.map((lab) => (
            <LabCard key={lab.id} lab={lab} onChanged={reload} showOwner={showOwner} />
          ))}
          {scope === 'mine' && (
            <Link
              to="/labs/new"
              className="flex min-h-[18rem] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-ink-700 text-slate-400 transition hover:border-accent/60 hover:text-blue-200"
            >
              <Plus className="size-8" />
              <span className="text-sm font-medium">Deploy a new lab</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
