import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, RefreshCw, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { useAction } from '../lib/app-context';
import { dateTime, relativeTime } from '../lib/format';
import { Spinner } from './ui';

interface UpdatesView {
  current: string;
  formFactor: 'appliance' | 'container' | 'host';
  oneClick: boolean;
  source: string | null;
  autoCheck: boolean;
  checkedAt: string | null;
  checkError: string | null;
  available: { version: string; notes: string; published: string; size: number; releaseUrl: string | null; staged: boolean; minFromVersion: string } | null;
  download: { version: string; received: number; total: number; error: string | null; done: boolean; install: boolean; installError?: string } | null;
  status: {
    state: 'running' | 'succeeded' | 'failed' | 'rolled_back';
    version: string;
    fromVersion?: string;
    step?: string;
    steps: { name: string; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' }[];
    message?: string;
    startedAt?: string;
    finishedAt?: string;
  } | null;
  manualSteps: string[] | null;
}

/** The version this browser page was loaded with: once the server reports another, the page needs a reload. */
let loadedVersion: string | null = null;

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

function Bar({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-700">
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </div>
  );
}

/** About → Updates (administrators): check, one-click update with progress, offline bundle, reload when done. */
export function UpdatesPanel() {
  const run = useAction();
  const [v, setV] = useState<UpdatesView | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [checking, setChecking] = useState(false);
  const [upload, setUpload] = useState<{ sent: number; total: number; error?: string } | null>(null);
  const [requested, setRequested] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const d = await api.get<UpdatesView>('/api/admin/updates');
      if (!loadedVersion) loadedVersion = d.current;
      setV(d);
      setUnreachable(false);
    } catch {
      // While the portal restarts during an update it doesn't answer for a minute.
      setUnreachable(true);
    }
  };
  const busy =
    unreachable ||
    requested ||
    v?.status?.state === 'running' ||
    Boolean(v?.download && !v.download.done && !v.download.error) ||
    Boolean(v?.download?.done && v.download.install && !v.download.installError && v.status?.version !== v.download.version);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), busy ? 2000 : 30_000);
    return () => clearInterval(t);
  }, [busy]);
  // The request was picked up (or the portal restarted): stop assuming.
  useEffect(() => {
    if (requested && v && (v.status?.state === 'running' || v.download?.error || v.download?.installError)) setRequested(false);
  }, [v, requested]);

  if (!v) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Spinner /> Checking the update status…
      </div>
    );
  }

  const updated = loadedVersion && v.current !== loadedVersion;
  const st = v.status;
  const recent = st?.finishedAt && Date.now() - Date.parse(st.finishedAt) < 24 * 3600_000;
  const check = async () => {
    setChecking(true);
    await run(() => api.post('/api/admin/updates/check').then((d) => setV(d as UpdatesView)));
    setChecking(false);
  };
  const update = () =>
    run(async () => {
      setRequested(true);
      setV(await api.post<UpdatesView>('/api/admin/updates/download', { install: true }));
    }).then((ok) => !ok && setRequested(false));
  const sendBundle = (file: File) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/admin/updates/upload');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-holoportal', '1');
    xhr.upload.onprogress = (e) => setUpload({ sent: e.loaded, total: e.total || file.size });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setUpload(null);
        setV(JSON.parse(xhr.responseText));
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).error ?? msg;
        } catch {
          /* not JSON */
        }
        setUpload({ sent: 0, total: file.size, error: msg });
      }
    };
    xhr.onerror = () => setUpload({ sent: 0, total: file.size, error: 'The upload was interrupted.' });
    setUpload({ sent: 0, total: file.size });
    xhr.send(file);
  };

  // --- finished: reload ---------------------------------------------------------------------------------------
  if (updated || (st?.state === 'succeeded' && st.version === v.current && recent && loadedVersion !== v.current)) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-emerald-300">
          <CheckCircle2 className="size-4" /> Updated to {v.current}.
        </div>
        <p className="text-xs text-slate-400">Reload the page to use the new version.</p>
        <button className="btn-primary" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" /> Reload
        </button>
      </div>
    );
  }

  // --- in progress ---------------------------------------------------------------------------------------------
  if (busy) {
    const d = v.download;
    const downloading = d && !d.done && !d.error;
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-white">
          <Spinner /> Updating to {st?.state === 'running' ? st.version : d?.version ?? v.available?.version}…
        </div>
        {downloading && (
          <div className="space-y-1">
            <div className="text-xs text-slate-400">
              Downloading {mb(d.received)} of {mb(d.total)}
            </div>
            <Bar value={(d.received / d.total) * 100} />
          </div>
        )}
        {st?.state === 'running' && (
          <ol className="space-y-1 text-xs">
            {st.steps.map((s) => (
              <li key={s.name} className="flex items-center gap-2">
                {s.status === 'done' ? (
                  <CheckCircle2 className="size-3.5 text-emerald-400" />
                ) : s.status === 'running' ? (
                  <Spinner />
                ) : (
                  <span className="inline-block size-3.5 rounded-full border border-ink-500" />
                )}
                <span className={s.status === 'pending' ? 'text-slate-500' : 'text-slate-200'}>{s.name}</span>
              </li>
            ))}
          </ol>
        )}
        {(unreachable || (st?.state === 'running' && st.step?.startsWith('Switch'))) && (
          <p className="text-xs text-slate-400">The portal is restarting with the new version; this page reconnects by itself.</p>
        )}
        {!downloading && st?.state !== 'running' && !unreachable && <p className="text-xs text-slate-400">Verifying and handing the release to the appliance's updater…</p>}
        <p className="text-xs text-slate-500">Lab jobs running on Holorouters carry on during the update.</p>
      </div>
    );
  }

  // --- idle ------------------------------------------------------------------------------------------------------
  const a = v.available;
  return (
    <div className="space-y-3 text-sm">
      {st && recent && (st.state === 'rolled_back' || st.state === 'failed') && (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            The update to {st.version} {st.state === 'rolled_back' ? 'was rolled back' : 'did not complete'}: {st.message}
          </span>
        </div>
      )}
      {v.download?.error && <p className="text-xs text-red-300">Download failed: {v.download.error}</p>}
      {v.download?.installError && <p className="text-xs text-amber-200">{v.download.installError}</p>}

      {a ? (
        <div className="space-y-2">
          <div className="font-medium text-white">
            Version {a.version} is available <span className="font-normal text-slate-400">(you have {v.current})</span>
          </div>
          <div className="text-xs text-slate-500">
            Published {dateTime(a.published)} · {mb(a.size)}
            {a.releaseUrl && (
              <>
                {' · '}
                <a className="text-blue-300 hover:underline" href={a.releaseUrl} target="_blank" rel="noreferrer">
                  release page
                </a>
              </>
            )}
          </div>
          {a.notes && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-900 p-3 font-sans text-xs text-slate-300">{a.notes}</pre>}
          {v.oneClick ? (
            <button className="btn-primary" onClick={() => void update()}>
              <Download className="size-4" /> Update to {a.version}
            </button>
          ) : (
            <div className="space-y-1 rounded-lg bg-ink-900 p-3 text-xs text-slate-300">
              <div className="text-slate-400">This installation updates on its Docker host:</div>
              {v.manualSteps?.map((s, i) => (
                <div key={i} className={i ? 'font-mono' : ''}>
                  {s}
                </div>
              ))}
            </div>
          )}
          {v.oneClick && (
            <p className="text-xs text-slate-500">
              The appliance verifies the release, backs up the portal, switches over and checks the new version; if it doesn't come up, it goes back to {v.current}{' '}
              automatically. About a minute of downtime.
            </p>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-emerald-300">
          <CheckCircle2 className="size-4" /> {v.source ? `You're up to date (${v.current}).` : `Version ${v.current}.`}
        </div>
      )}

      <div className="text-xs text-slate-500">
        {v.source ? (
          <>
            Source: {v.source}
            {v.checkedAt ? ` · checked ${relativeTime(v.checkedAt)}` : ' · not checked yet'}
            {!v.autoCheck && ' · automatic checks off'}
          </>
        ) : (
          'No update source is set (Settings → Updates). Offline bundles can still be uploaded.'
        )}
        {v.checkError && <div className="mt-1 text-red-300">Last check failed: {v.checkError}</div>}
      </div>

      <div className="flex flex-wrap gap-2">
        {v.source && (
          <button className="btn-secondary" disabled={checking} onClick={() => void check()}>
            {checking ? <Spinner /> : <RefreshCw className="size-4" />} Check now
          </button>
        )}
        {v.oneClick && (
          <button className="btn-secondary" disabled={Boolean(upload && !upload.error)} onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" /> Upload update file
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".hpupdate"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) sendBundle(f);
            e.target.value = '';
          }}
        />
      </div>
      {upload && !upload.error && (
        <div className="space-y-1">
          <div className="text-xs text-slate-400">
            {upload.sent < upload.total ? `Uploading ${mb(upload.sent)} of ${mb(upload.total)}` : 'Verifying the bundle…'}
          </div>
          <Bar value={(upload.sent / upload.total) * 100} />
        </div>
      )}
      {upload?.error && <p className="text-xs text-red-300">{upload.error}</p>}
      {v.oneClick && <p className="text-xs text-slate-500">For sites without internet access: upload the release's .hpupdate file; it is verified the same way.</p>}
    </div>
  );
}
