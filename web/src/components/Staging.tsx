import { useState } from 'react';
import { CheckCircle2, CircleDashed, FolderInput, Trash2, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useAction } from '../lib/app-context';
import { useApi } from '../lib/hooks';
import { relativeTime } from '../lib/format';
import type { Holorouter, Job, VersionStaging } from '../lib/types';
import { JobConsole } from './JobConsole';
import { ConfirmDialog, InfoNote, Spinner } from './ui';

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const label = (v: VersionStaging) => `VCF ${v.version}`;
const installerName = (v: VersionStaging) => (v.installerKind === 'cloud-builder' ? 'Cloud Builder OVA' : 'VCF Installer OVA');

function StatusChip({ status }: { status: VersionStaging['status'] }) {
  if (status === 'ready')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
        <CheckCircle2 className="size-3.5" /> Staged
      </span>
    );
  if (status === 'incomplete')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-300">
        <XCircle className="size-3.5" /> Incomplete
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
      <CircleDashed className="size-3.5" /> Not present
    </span>
  );
}

/** What is wrong with an incomplete or missing version, in Holodeck's terms. */
function Problems({ v }: { v: VersionStaging }) {
  if (v.status === 'ready') return null;
  const missing = [
    !v.esx && { what: 'ESX installer ISO', names: v.expected.esx },
    !v.installer && { what: installerName(v), names: v.expected.installer },
  ].filter(Boolean) as { what: string; names: string[] }[];
  return (
    <div className="mt-1 space-y-0.5 text-xs text-slate-500">
      {missing.map((m) => (
        <div key={m.what}>
          Needs {m.what}: <span className="font-mono text-slate-400">{m.names.join(' or ')}</span>
        </div>
      ))}
      {v.other.length > 0 && (
        <div className="text-amber-300/80">
          Not accepted by Holodeck’s precheck: <span className="font-mono">{v.other.map((f) => f.name).join(', ')}</span>
        </div>
      )}
    </div>
  );
}

function Files({ v }: { v: VersionStaging }) {
  const files = [v.esx, v.installer].filter(Boolean) as { name: string; size: number }[];
  if (!files.length) return null;
  return (
    <div className="mt-1 space-y-0.5 font-mono text-[11px] text-slate-400">
      {files.map((f) => (
        <div key={f.name}>
          {f.name} <span className="text-slate-600">({gb(f.size)})</span>
        </div>
      ))}
    </div>
  );
}

type FleetVersion = VersionStaging & { sources: string[] };

/** A router's installation files: what it has, copying from other routers that have a version, and removal. */
export function RouterStagingPanel({ router, onChanged }: { router: Holorouter; onChanged: () => void }) {
  const fleet = useApi<{ staging: { versions: FleetVersion[] } }>('/api/admin/staging');
  const run = useAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [job, setJob] = useState<string | null>(null);
  const [remove, setRemove] = useState<VersionStaging | null>(null);
  const activeJob = job ?? router.stagingJobId;
  const staging = router.staging;
  const usable = ['ready', 'attention'].includes(router.status);
  if (!fleet.data) return <Spinner className="mx-auto size-5" />;
  const source = Object.fromEntries(fleet.data.staging.versions.map((v) => [v.version, v]));
  const here = Object.fromEntries((staging?.versions ?? []).map((v) => [v.version, v]));
  const versions = [...new Set([...fleet.data.staging.versions.map((v) => v.version), ...(staging?.versions ?? []).map((v) => v.version)])];
  const others = (v: string) => (source[v]?.sources ?? []).filter((n) => n !== router.name);
  const toggle = (v: string) => setSelected((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]));
  const bytes = selected.reduce((n, v) => n + (source[v]?.esx?.size ?? 0) + (source[v]?.installer?.size ?? 0), 0);
  const stage = async () => {
    const r = await run(() => api.post<{ job: Job }>(`/api/admin/holorouters/${router.id}/stage`, { versions: selected }), 'Staging started');
    if (r) {
      setJob(r.job.id);
      setSelected([]);
      onChanged();
    }
  };
  return (
    <div className="panel space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="label-caps">Installation files</h3>
          <p className="mt-1 text-sm text-slate-400">
            Labs are only placed on this router for versions staged here. Staging copies the files from another Holorouter that has them,
            through the portal (resumable, checked with SHA-256). Files placed here by hand are found at the next check.
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          {router.inspection?.diskFreeGB !== undefined && <div>{router.inspection.diskFreeGB} GB free at last check</div>}
          {staging?.checkedAt && <div>Read {relativeTime(staging.checkedAt)}</div>}
        </div>
      </div>
      {staging?.error && <InfoNote tone="warn">{staging.error}</InfoNote>}
      <div className="divide-y divide-ink-700">
        {versions.map((version) => {
          const src = source[version] ?? here[version];
          const dst = here[version];
          const staged = dst?.status === 'ready';
          const from = others(version);
          const available = from.length > 0;
          const disabled = staged || !available || !usable || Boolean(activeJob);
          return (
            <div key={version} className={`flex flex-wrap items-start justify-between gap-2 py-2.5 ${!available && !staged ? 'opacity-50' : ''}`}>
              <label className={`flex min-w-0 items-start gap-3 ${disabled ? '' : 'cursor-pointer'}`}>
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={disabled}
                  checked={staged || selected.includes(version)}
                  onChange={() => toggle(version)}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white">{label(src)}</div>
                  {dst && dst.status !== 'missing' && <Problems v={dst} />}
                  {staged ? (
                    <Files v={dst} />
                  ) : available ? (
                    <div className="mt-0.5 text-xs text-slate-500">
                      {gb((src.esx?.size ?? 0) + (src.installer?.size ?? 0))} to copy from {from[0]}
                      {dst?.status === 'incomplete' && ' (a partial or different copy is here)'}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-xs text-slate-500">
                      No other Holorouter has it: download it from the Broadcom support portal into{' '}
                      <span className="font-mono">/holodeck-runtime/bin/{version}</span> on any Holorouter, under the exact names Holodeck’s
                      bill of materials lists.
                    </div>
                  )}
                </div>
              </label>
              <div className="flex items-center gap-3">
                <StatusChip status={dst?.status ?? 'missing'} />
                {dst && dst.status !== 'missing' && (
                  <button
                    className="btn-ghost p-1 text-slate-400 hover:text-red-300"
                    title="Delete these files from this router"
                    disabled={Boolean(activeJob) || !usable}
                    onClick={() => setRemove(dst)}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" disabled={!selected.length || Boolean(activeJob) || !usable} onClick={stage}>
          <FolderInput className="size-4" /> Stage selected
        </button>
        {selected.length > 0 && <span className="text-xs text-slate-400">{gb(bytes)} to copy</span>}
        {!usable && <span className="text-xs text-slate-500">The router must be ready to stage files.</span>}
      </div>
      {activeJob && (
        <JobConsole
          jobId={activeJob}
          height="h-56"
          onFinished={() => {
            setJob(null);
            onChanged();
          }}
        />
      )}
      <ConfirmDialog
        open={remove !== null}
        title={`Delete VCF ${remove?.version} files from ${router.name}?`}
        message="This frees the disk space on this router. Labs of this version won't be placed here until it is staged again. Other routers' copies are not touched."
        confirmLabel="Delete files"
        danger
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          const ok = await run(() => api.del(`/api/admin/holorouters/${router.id}/staging/${remove!.version}`), 'Files deleted');
          if (ok) onChanged();
          setRemove(null);
        }}
      />
    </div>
  );
}

/** Version checkboxes for the Deploy / Import dialogs; copied once the new router passes its checks. */
export function StagePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const fleet = useApi<{ staging: { versions: FleetVersion[] } }>('/api/admin/staging');
  if (!fleet.data) return <Spinner />;
  const versions = fleet.data.staging.versions;
  const ready = versions.filter((v) => v.status === 'ready');
  const bytes = value.reduce((n, id) => {
    const v = versions.find((x) => x.version === id);
    return n + (v?.esx?.size ?? 0) + (v?.installer?.size ?? 0);
  }, 0);
  return (
    <div className="space-y-2">
      <div className="grid gap-1.5 sm:grid-cols-3">
        {versions.map((v) => (
          <label
            key={v.version}
            className={`flex items-center gap-2 text-sm ${v.status === 'ready' ? 'cursor-pointer text-slate-200' : 'text-slate-600'}`}
            title={v.status === 'ready' ? `Copied from ${v.sources[0]}` : `No Holorouter has it yet: place the files in /holodeck-runtime/bin/${v.version} on any router`}
          >
            <input
              type="checkbox"
              disabled={v.status !== 'ready'}
              checked={value.includes(v.version)}
              onChange={() => onChange(value.includes(v.version) ? value.filter((x) => x !== v.version) : [...value, v.version])}
            />
            {label(v)}
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        {value.length ? `${gb(bytes)} will be copied once the router passes its checks. ` : ''}
        {ready.length < versions.length &&
          'Greyed-out versions are on no Holorouter yet: download them from the Broadcom support portal into /holodeck-runtime/bin/<version> on any Holorouter.'}
      </p>
    </div>
  );
}
