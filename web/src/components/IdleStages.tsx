import { Toggle } from './ui';

export interface IdleStage {
  enabled: boolean;
  days: number;
}
export interface IdleStages {
  suspend: IdleStage;
  shutdown: IdleStage;
}

/** The two independent stages of the idle policy: suspend after N days, shut down after M days. */
export function IdleStagesEditor({ value, onChange }: { value: IdleStages; onChange: (v: IdleStages) => void }) {
  const row = (key: keyof IdleStages, label: string) => (
    <div className="flex flex-wrap items-center gap-3">
      <Toggle checked={value[key].enabled} onChange={(enabled) => onChange({ ...value, [key]: { ...value[key], enabled } })} label={label} />
      <span className="text-sm text-slate-400">after</span>
      <input
        className="input w-24"
        type="number"
        min={1}
        max={365}
        value={value[key].days}
        disabled={!value[key].enabled}
        onChange={(e) => onChange({ ...value, [key]: { ...value[key], days: Math.max(1, Math.floor(Number(e.target.value))) } })}
      />
      <span className="text-sm text-slate-400">days without use</span>
    </div>
  );
  return (
    <div className="space-y-3">
      {row('suspend', 'Suspend')}
      {row('shutdown', 'Shut down')}
    </div>
  );
}

/** "Suspend after 7 days, shut down after 14" / "Off". */
export function describeIdle(v: IdleStages): string {
  const parts = [v.suspend.enabled && `suspend after ${v.suspend.days} days`, v.shutdown.enabled && `shut down after ${v.shutdown.days} days`].filter(Boolean) as string[];
  if (!parts.length) return 'Off';
  const text = parts.join(', ');
  return text[0].toUpperCase() + text.slice(1);
}
