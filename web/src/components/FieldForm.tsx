import type { FieldDef } from '../lib/types';
import { Field, Toggle } from './ui';

/** Renders Holodeck parameter fields described by the server catalog. */
export function FieldForm({
  fields,
  values,
  onChange,
  columns = 2,
}: {
  fields: FieldDef[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  columns?: 1 | 2;
}) {
  const booleans = fields.filter((f) => f.type === 'boolean');
  const others = fields.filter((f) => f.type !== 'boolean');
  return (
    <div className="space-y-4">
      {others.length > 0 && (
        <div className={`grid gap-4 ${columns === 2 ? 'sm:grid-cols-2' : ''}`}>
          {others.map((f) => (
            <Field
              key={f.name}
              label={
                <>
                  {f.label}
                  {f.required && <span className="text-red-400"> *</span>}
                </>
              }
              help={f.help}
            >
              <FieldInput field={f} value={values[f.name]} onChange={(v) => onChange(f.name, v)} />
            </Field>
          ))}
        </div>
      )}
      {booleans.length > 0 && (
        <div className={`grid gap-3 ${columns === 2 ? 'sm:grid-cols-2' : ''}`}>
          {booleans.map((f) => (
            <Toggle key={f.name} checked={Boolean(values[f.name])} onChange={(v) => onChange(f.name, v)} label={f.label} help={f.help} />
          ))}
        </div>
      )}
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  switch (field.type) {
    case 'select':
      return (
        <select className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o === '' ? '— none —' : o}
            </option>
          ))}
        </select>
      );
    case 'number':
      return (
        <input
          className="input"
          type="number"
          min={field.min}
          max={field.max}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    case 'password':
      return <input className="input" type="password" autoComplete="new-password" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'list':
      return (
        <input
          className="input"
          value={Array.isArray(value) ? value.join(', ') : String(value ?? '')}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return <input className="input" value={String(value ?? '')} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function fieldDefaults(fields: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.default !== undefined) out[f.name] = f.default;
    else if (f.type === 'select' && f.options?.length) out[f.name] = f.options[0];
  }
  return out;
}
