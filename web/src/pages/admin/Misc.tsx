import { useState } from 'react';
import { useApi } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { PageHeader, Spinner } from '../../components/ui';
import { LabGrid } from '../Dashboard';

export function AdminLabs() {
  return (
    <div>
      <PageHeader title="All labs" subtitle="Every lab in the portal, including other users'." />
      <LabGrid scope="all" showOwner />
    </div>
  );
}

interface AuditEntry {
  id: number;
  ts: string;
  username: string | null;
  action: string;
  target: string | null;
  details: unknown;
  ip: string | null;
}

export function Audit() {
  const { data } = useApi<{ entries: AuditEntry[] }>('/api/admin/audit?limit=500', { interval: 20_000 });
  const [q, setQ] = useState('');
  const rows = (data?.entries ?? []).filter((e) => !q || JSON.stringify(e).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Sign-ins, lab operations, credential views and administrative changes." actions={<input className="input w-64" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />} />
      {!data ? (
        <Spinner className="mx-auto size-6" />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Target</th>
                <th>Details</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap text-slate-400">{dateTime(e.ts)}</td>
                  <td>{e.username ?? '—'}</td>
                  <td className="font-mono text-xs text-slate-100">{e.action}</td>
                  <td className="font-mono text-xs text-slate-400">{e.target ?? '—'}</td>
                  <td className="max-w-md truncate font-mono text-xs text-slate-500" title={e.details ? JSON.stringify(e.details) : ''}>
                    {e.details ? JSON.stringify(e.details) : ''}
                  </td>
                  <td className="font-mono text-xs text-slate-500">{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
