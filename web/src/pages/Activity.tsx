import { Link, useParams } from 'react-router-dom';
import { Activity as ActivityIcon } from 'lucide-react';
import { useApi, useNow } from '../lib/hooks';
import { dateTime, duration, jobTypeLabel, relativeTime } from '../lib/format';
import type { Job } from '../lib/types';
import { EmptyState, JobStatusBadge, PageHeader, Spinner } from '../components/ui';
import { JobConsole } from '../components/JobConsole';

export function ActivityList({ labId, onSelect, selected }: { labId?: number; onSelect?: (id: string) => void; selected?: string | null }) {
  const now = useNow(10_000);
  const { data, loading } = useApi<{ jobs: Job[] }>(`/api/jobs?limit=100${labId ? `&labId=${labId}` : ''}`, { interval: 5000 });
  if (loading && !data) return <Spinner className="mx-auto size-6" />;
  if (!data?.jobs.length) return <EmptyState icon={<ActivityIcon className="size-6" />} title="No activity yet" />;
  return (
    <div className="panel overflow-x-auto">
      <table className="table-base">
        <thead>
          <tr>
            <th>Operation</th>
            {!labId && <th>Lab / target</th>}
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>
          {data.jobs.map((j) => {
            const detail = describe(j);
            const rowCls = selected === j.id ? 'bg-accent-soft/30' : 'hover:bg-ink-800';
            return (
              <tr key={j.id} className={`${rowCls} cursor-pointer`} onClick={() => onSelect?.(j.id)}>
                <td>
                  {onSelect ? (
                    <span className="font-medium text-slate-100">{jobTypeLabel[j.type] ?? j.type}</span>
                  ) : (
                    <Link to={`/jobs/${j.id}`} className="font-medium text-slate-100 hover:underline">
                      {jobTypeLabel[j.type] ?? j.type}
                    </Link>
                  )}
                  {detail && <div className="text-xs text-slate-400">{detail}</div>}
                </td>
                {!labId && (
                  <td className="text-slate-300">
                    {j.labId ? <Link to={`/labs/${j.labId}`} className="hover:underline">{j.labName ?? `Lab ${j.labId}`}</Link> : String(j.display.config ?? '—')}
                  </td>
                )}
                <td>
                  <JobStatusBadge status={j.status} />
                </td>
                <td className="text-slate-400" title={dateTime(j.startedAt ?? j.createdAt)}>
                  {relativeTime(j.startedAt ?? j.createdAt, now)}
                </td>
                <td className="text-slate-400 tabular-nums">{duration(j.startedAt, j.finishedAt, now)}</td>
                <td className="text-slate-400">{j.username ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function describe(j: Job): string {
  const d = j.display as Record<string, unknown>;
  if (j.type === 'lab-power') return `${d.action}${d.reason ? ` — ${d.reason}` : ''}`;
  if (j.type === 'lab-deploy') return [d.mode, d.version, d.cidr, d.retry ? 'retry' : null].filter(Boolean).join(' · ');
  if (j.type === 'lab-day2') return String(d.action ?? '');
  if (j.type === 'config-set') return String(d.set ?? '');
  if (j.error && j.status === 'failed') return j.error;
  return '';
}

export function Activity() {
  return (
    <div>
      <PageHeader title="Activity" subtitle="Holodeck operations you started or that ran against your labs." />
      <ActivityList />
    </div>
  );
}

export function JobPage() {
  const { id } = useParams();
  const { data, reload } = useApi<{ job: Job }>(id ? `/api/jobs/${id}` : null);
  const job = data?.job;
  return (
    <div>
      <PageHeader
        title={job ? jobTypeLabel[job.type] ?? job.type : 'Job'}
        subtitle={
          job && (
            <>
              Started {dateTime(job.startedAt ?? job.createdAt)}
              {job.labId && (
                <>
                  {' '}
                  · <Link to={`/labs/${job.labId}`} className="text-blue-300 hover:underline">Open lab</Link>
                </>
              )}
            </>
          )
        }
      />
      {id && <JobConsole jobId={id} height="h-[65vh]" onFinished={() => void reload()} />}
      {job?.result && Object.keys(job.result).filter((k) => k !== 'hasSnapshot' && k !== 'error').length > 0 && (
        <div className="panel mt-6 p-4">
          <div className="label-caps mb-2">Result</div>
          <pre className="overflow-x-auto font-mono text-xs text-slate-300">
            {JSON.stringify(Object.fromEntries(Object.entries(job.result).filter(([k]) => k !== 'hasSnapshot')), null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
