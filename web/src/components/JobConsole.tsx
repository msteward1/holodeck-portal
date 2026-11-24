import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, KeyRound, Square, TerminalSquare } from 'lucide-react';
import { api } from '../lib/api';
import { useAction } from '../lib/app-context';
import type { Job, JobStatus } from '../lib/types';
import { ConfirmDialog, JobStatusBadge, Spinner } from './ui';

// --- ANSI colour rendering --------------------------------------------------

const fg: Record<number, string> = {
  30: 'text-slate-500', 31: 'text-red-400', 32: 'text-emerald-400', 33: 'text-amber-300', 34: 'text-blue-400',
  35: 'text-fuchsia-400', 36: 'text-cyan-300', 37: 'text-slate-200', 90: 'text-slate-500', 91: 'text-red-300',
  92: 'text-emerald-300', 93: 'text-yellow-200', 94: 'text-sky-300', 95: 'text-pink-300', 96: 'text-cyan-200', 97: 'text-white',
};

function renderAnsi(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let cls = '';
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<span key={key++} className={cls}>{text.slice(last, m.index)}</span>);
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0 || code === 39) cls = '';
      else if (fg[code]) cls = fg[code];
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<span key={key++} className={cls}>{text.slice(last)}</span>);
  return out;
}

// --- Log viewer ---------------------------------------------------------------

const ACTIVE: JobStatus[] = ['queued', 'running', 'waiting_input'];

interface LogResponse {
  text: string;
  next: number;
  size: number;
  status: JobStatus;
  prompt: Job['prompt'];
}

/** Live job log with prompt answering. Polls while the job is active. */
export function JobConsole({ jobId, onFinished, height = 'h-[28rem]' }: { jobId: string; onFinished?: (status: JobStatus) => void; height?: string }) {
  const [chunks, setChunks] = useState<string[]>([]);
  const [status, setStatus] = useState<JobStatus>('queued');
  const [prompt, setPrompt] = useState<Job['prompt']>(null);
  const [follow, setFollow] = useState(true);
  const offset = useRef(0);
  const box = useRef<HTMLPreElement>(null);
  const finishedFor = useRef<string | null>(null);

  useEffect(() => {
    offset.current = 0;
    setChunks([]);
    finishedFor.current = null;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api.get<LogResponse>(`/api/jobs/${jobId}/log?offset=${offset.current}`);
        if (stop) return;
        if (r.text) setChunks((c) => [...c, r.text]);
        offset.current = r.next;
        setStatus(r.status);
        setPrompt(r.prompt);
        const more = r.next < r.size;
        if (ACTIVE.includes(r.status) || more) {
          timer = setTimeout(poll, more ? 50 : 1500);
        } else if (finishedFor.current !== jobId) {
          finishedFor.current = jobId;
          onFinished?.(r.status);
        }
      } catch {
        if (!stop) timer = setTimeout(poll, 4000);
      }
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [chunks, follow]);

  return (
    <div className="overflow-hidden rounded-xl border border-ink-700 bg-ink-950">
      <div className="flex items-center justify-between border-b border-ink-700 bg-ink-900 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <TerminalSquare className="size-4" />
          <span className="font-mono">job {jobId.slice(0, 8)}</span>
          <JobStatusBadge status={status} />
        </div>
        <div className="flex items-center gap-1">
          <button
            className={`btn-ghost px-2 py-1 text-xs ${follow ? 'text-accent' : ''}`}
            onClick={() => setFollow((f) => !f)}
            title="Follow output"
          >
            <ArrowDownToLine className="size-3.5" /> Follow
          </button>
          {ACTIVE.includes(status) && <CancelJob jobId={jobId} />}
        </div>
      </div>
      <pre
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!atBottom && follow) setFollow(false);
        }}
        className={`${height} overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-slate-300`}
      >
        {chunks.length === 0 && status === 'queued' && <span className="text-slate-500">Waiting for the Holodeck lock…</span>}
        {chunks.map((c, i) => (
          <Fragment key={i}>{renderAnsi(c)}</Fragment>
        ))}
        {status === 'running' && (
          <span className="inline-flex items-center gap-2 text-slate-500">
            <Spinner className="size-3" /> running
          </span>
        )}
      </pre>
      {prompt && status === 'waiting_input' && <PromptBar jobId={jobId} prompt={prompt} onAnswered={() => setPrompt(null)} />}
    </div>
  );
}

function PromptBar({ jobId, prompt, onAnswered }: { jobId: string; prompt: NonNullable<Job['prompt']>; onAnswered: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useAction();
  const yesNo = /\((y\s*\|\s*n|y\/n|yes\s*\|\s*no)\)/i.test(prompt.prompt);
  const send = async (v: string) => {
    setBusy(true);
    const ok = await run(() => api.post(`/api/jobs/${jobId}/answer`, { value: v }));
    setBusy(false);
    if (ok) {
      setValue('');
      onAnswered();
    }
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t border-amber-500/30 bg-amber-500/10 px-3 py-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void send(value);
      }}
    >
      <KeyRound className="size-4 text-amber-300" />
      <span className="text-sm text-amber-100">{prompt.prompt}</span>
      <div className="ml-auto flex min-w-[16rem] flex-1 gap-2">
        <input
          className="input py-1.5"
          type={prompt.secure ? 'password' : 'text'}
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={prompt.secure ? 'Hidden input' : 'Answer'}
        />
        {yesNo && (
          <>
            <button type="button" className="btn-secondary py-1.5" disabled={busy} onClick={() => send(/yes/i.test(prompt.prompt) ? 'yes' : 'y')}>
              Yes
            </button>
            <button type="button" className="btn-secondary py-1.5" disabled={busy} onClick={() => send(/yes/i.test(prompt.prompt) ? 'no' : 'n')}>
              No
            </button>
          </>
        )}
        <button className="btn-primary py-1.5" disabled={busy}>
          {busy ? <Spinner /> : 'Send'}
        </button>
      </div>
    </form>
  );
}

function CancelJob({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const run = useAction();
  return (
    <>
      <button className="btn-ghost px-2 py-1 text-xs text-red-300" onClick={() => setOpen(true)}>
        <Square className="size-3.5" /> Cancel
      </button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        danger
        title="Cancel this job?"
        confirmLabel="Cancel job"
        message="Holodeck will be stopped mid-operation. A cancelled deployment is marked failed; you can retry it (Holodeck resumes from its state) or remove the lab."
        onConfirm={() => run(() => api.post(`/api/jobs/${jobId}/cancel`), 'Job cancelled')}
      />
    </>
  );
}
