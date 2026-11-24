import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, Loader2, X } from 'lucide-react';
import type { JobStatus, LabStatus } from '../lib/types';

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} />;
}

const labStatusStyle: Record<LabStatus, { dot: string; text: string; label: string }> = {
  queued: { dot: 'bg-slate-400', text: 'text-slate-300', label: 'Queued' },
  deploying: { dot: 'bg-sky-400 animate-pulse', text: 'text-sky-300', label: 'Deploying' },
  ready: { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Ready' },
  failed: { dot: 'bg-red-400', text: 'text-red-400', label: 'Failed' },
  removing: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'Removing' },
  removed: { dot: 'bg-slate-600', text: 'text-slate-500', label: 'Removed' },
};

export function LabStatusBadge({ status }: { status: LabStatus }) {
  const s = labStatusStyle[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.12em] uppercase ${s.text}`}>
      <span className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

const powerStyle: Record<string, { cls: string; label: string }> = {
  on: { cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', label: 'Powered on' },
  off: { cls: 'bg-slate-500/10 text-slate-300 border-slate-500/30', label: 'Powered off' },
  partial: { cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', label: 'Partially on' },
  starting: { cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', label: 'Starting…' },
  stopping: { cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', label: 'Stopping…' },
  suspended: { cls: 'bg-violet-500/10 text-violet-300 border-violet-500/30', label: 'Suspended' },
  suspending: { cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', label: 'Suspending…' },
  absent: { cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30', label: 'No VMs' },
  unknown: { cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30', label: 'Power unknown' },
};

export function PowerBadge({ state }: { state: string }) {
  const s = powerStyle[state] ?? powerStyle.unknown;
  return <span className={`rounded-md border px-2 py-0.5 text-xs ${s.cls}`}>{s.label}</span>;
}

const jobStyle: Record<JobStatus, string> = {
  queued: 'text-slate-300 bg-slate-500/10 border-slate-500/30',
  running: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  waiting_input: 'text-amber-300 bg-amber-500/10 border-amber-500/40',
  succeeded: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  failed: 'text-red-300 bg-red-500/10 border-red-500/30',
  cancelled: 'text-slate-400 bg-slate-500/10 border-slate-500/30',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${jobStyle[status]}`}>
      {(status === 'running' || status === 'queued') && <Spinner className="size-3" />}
      {status === 'waiting_input' ? 'Input required' : status[0].toUpperCase() + status.slice(1)}
    </span>
  );
}

export function StatTile({
  icon,
  tint,
  label,
  value,
  suffix,
  sub,
  subTone = 'muted',
}: {
  icon: ReactNode;
  tint: string;
  label: string;
  value: ReactNode;
  suffix?: string;
  sub?: ReactNode;
  subTone?: 'muted' | 'good' | 'warn' | 'bad';
}) {
  const subCls = { muted: 'text-slate-400', good: 'text-emerald-400', warn: 'text-amber-400', bad: 'text-red-400' }[subTone];
  return (
    <div className="panel min-w-[13rem] flex-1 px-5 py-4">
      <div className="flex items-center gap-3">
        <span className={`grid size-8 place-items-center rounded-lg ${tint}`}>{icon}</span>
        <span className="label-caps">{label}</span>
      </div>
      <div className="mt-3 text-center">
        <div className="text-4xl font-bold tracking-tight text-white">
          {value}
          {suffix && <span className="ml-0.5 text-xl text-slate-400">{suffix}</span>}
        </div>
        {sub && <div className={`mt-1 text-xs ${subCls}`}>{sub}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap justify-center gap-1 border-b border-ink-700">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition ${
            value === t.id ? 'border-accent font-semibold text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:pt-[8vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={`panel w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} bg-ink-850`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3.5">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <button className="btn-ghost -mr-2 p-1.5" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-ink-700 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  requireText,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** User must type this text to enable the confirm button. */
  requireText?: string;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className={danger ? 'btn-danger' : 'btn-primary'}
            disabled={busy || (requireText !== undefined && typed !== requireText)}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-300">
        {message}
        {requireText !== undefined && (
          <label className="block">
            <span className="text-xs text-slate-400">
              Type <code className="text-slate-200">{requireText}</code> to confirm
            </span>
            <input className="input mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </label>
        )}
      </div>
    </Modal>
  );
}

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      className={`rounded p-1 text-slate-400 hover:bg-ink-700 hover:text-white ${className}`}
      onClick={async () => {
        await navigator.clipboard?.writeText(text).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="panel flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-xl bg-ink-700 text-slate-300">{icon}</div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {children && <div className="max-w-md text-sm text-slate-400">{children}</div>}
    </div>
  );
}

export function Field({ label, help, children, className = '' }: { label: ReactNode; help?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-slate-300">{label}</span>
      {children}
      {help && <span className="mt-1 block text-xs text-slate-500">{help}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, help, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; help?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-ink-600'}`}
      >
        <span className={`absolute top-0.5 size-4 rounded-full bg-white transition ${checked ? 'left-4.5' : 'left-0.5'}`} />
      </button>
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {help && <span className="block text-xs text-slate-500">{help}</span>}
      </span>
    </label>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{children}</div>;
}

export function InfoNote({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  const cls = tone === 'warn' ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-sky-500/30 bg-sky-500/10 text-sky-200';
  return <div className={`rounded-lg border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}
