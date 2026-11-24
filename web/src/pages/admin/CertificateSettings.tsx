import { useState } from 'react';
import { Download, FileKey, RotateCcw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/app-context';
import { useApi } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { ConfirmDialog, CopyButton, Field, InfoNote, Modal, Spinner, Tabs, Toggle } from '../../components/ui';

interface CertInfo {
  subject: string;
  subjectDn: string;
  names: string[];
  issuer: string;
  issuerDn: string;
  selfSigned: boolean;
  notBefore: string;
  notAfter: string;
  daysLeft: number;
  sha256: string;
  keyType: string;
  coversPortal: boolean;
}
interface CertStatus {
  hostname: string;
  current: { leaf: CertInfo; chain: CertInfo[] } | null;
  previous: { leaf: CertInfo; chain: CertInfo[] } | null;
  pending: { subject: string; names: string[]; keyType: string; createdAt: string; csr: string } | null;
  formFactor: 'appliance' | 'container' | 'host';
}

const KEY_TYPES = [
  ['rsa-2048', 'RSA 2048 (widest support)'],
  ['rsa-3072', 'RSA 3072'],
  ['rsa-4096', 'RSA 4096'],
  ['ecdsa-p256', 'ECDSA P-256'],
  ['ecdsa-p384', 'ECDSA P-384'],
] as const;

const splitNames = (t: string) =>
  t
    .split(/[\s,]+/)
    .map((n) => n.trim())
    .filter(Boolean);

/** Certificate files as PEM text; a binary .cer/.der certificate is wrapped as PEM. */
async function readCertificateFile(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  if (text.includes('-----BEGIN')) return text;
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const b64 = btoa(bin).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/pkcs10' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CertSummary({ c, chain }: { c: CertInfo; chain?: CertInfo[] }) {
  const tone = c.daysLeft <= 7 ? 'text-red-400' : c.daysLeft <= 30 ? 'text-amber-300' : 'text-slate-200';
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-slate-500">Issued to</dt>
      <dd className="text-slate-200">
        {c.subject}
        {c.selfSigned && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">self-signed</span>}
      </dd>
      <dt className="text-slate-500">Names</dt>
      <dd className="font-mono text-xs text-slate-300">{c.names.join(', ') || '—'}</dd>
      <dt className="text-slate-500">Issued by</dt>
      <dd className="text-slate-300">
        {c.issuer}
        {chain && chain.length > 0 && <span className="text-slate-500"> (chain: {chain.map((x) => x.subject).join(' → ')})</span>}
      </dd>
      <dt className="text-slate-500">Valid until</dt>
      <dd className={tone}>
        {dateTime(c.notAfter)} ({c.daysLeft <= 0 ? 'expired' : `${c.daysLeft} days`})
      </dd>
      <dt className="text-slate-500">Key</dt>
      <dd className="text-slate-300">{c.keyType}</dd>
      <dt className="text-slate-500">SHA-256</dt>
      <dd className="break-all font-mono text-xs text-slate-400">{c.sha256}</dd>
    </dl>
  );
}

/** Settings → Certificate: CSR, install the signed certificate, upload certificate and key, self-signed, roll back. */
export function CertificateSettings() {
  const { data, reload } = useApi<CertStatus>('/api/admin/certificate');
  const run = useAction();
  const [dialog, setDialog] = useState<null | 'csr' | 'install' | 'upload' | 'self' | 'rollback' | 'discard'>(null);
  const after = (ok: unknown) => {
    if (ok) {
      setDialog(null);
      void reload();
    }
    return ok;
  };
  if (!data) {
    return (
      <section className="panel p-6">
        <Spinner />
      </section>
    );
  }
  const cur = data.current?.leaf;
  return (
    <section className="panel p-6 xl:col-span-2">
      <h2 className="text-base font-semibold text-white">Certificate</h2>
      <p className="mt-1 text-sm text-slate-400">
        The certificate the portal presents for <span className="font-mono">{data.hostname}</span>, also on the webtop gateway ports. The private key is
        created on the portal and never leaves it. Changes take effect at once; signed-in users stay signed in.
      </p>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <h3 className="label-caps">In use</h3>
          {cur ? <CertSummary c={cur} chain={data.current!.chain} /> : <p className="text-sm text-slate-400">No certificate found.</p>}
          {cur && !cur.coversPortal && <InfoNote tone="warn">This certificate does not name {data.hostname}: browsers warn on every visit.</InfoNote>}
          {cur?.selfSigned && (
            <InfoNote>Browsers don't trust a self-signed certificate. Generate a CSR, have your CA sign it, then install the signed certificate here.</InfoNote>
          )}
        </div>
        <div className="space-y-3">
          <h3 className="label-caps">Certificate request</h3>
          {data.pending ? (
            <>
              <p className="text-sm text-slate-300">
                Pending since {dateTime(data.pending.createdAt)} for <span className="font-mono text-xs">{data.pending.names.join(', ')}</span> (
                {data.pending.keyType.toUpperCase()}). Send the CSR to your CA, then install the certificate it returns.
              </p>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" onClick={() => download(`${data.hostname}.csr`, data.pending!.csr)}>
                  <Download className="size-4" /> Download CSR
                </button>
                <span className="btn-secondary !px-2">
                  <CopyButton text={data.pending.csr} /> Copy
                </span>
                <button className="btn-primary" onClick={() => setDialog('install')}>
                  <ShieldCheck className="size-4" /> Install signed certificate
                </button>
                <button className="btn-ghost" onClick={() => setDialog('discard')}>
                  <Trash2 className="size-4" /> Discard
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">None. Generating a CSR creates a new key; the current certificate stays in use until the signed one is installed.</p>
          )}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2 border-t border-ink-700 pt-5">
        <button className="btn-secondary" onClick={() => setDialog('csr')}>
          <FileKey className="size-4" /> {data.pending ? 'New CSR' : 'Generate CSR'}
        </button>
        <button className="btn-secondary" onClick={() => setDialog('upload')}>
          <Upload className="size-4" /> Upload certificate and key
        </button>
        <button className="btn-secondary" onClick={() => setDialog('self')}>
          Regenerate self-signed
        </button>
        {data.previous && (
          <button className="btn-secondary" onClick={() => setDialog('rollback')}>
            <RotateCcw className="size-4" /> Roll back to previous
          </button>
        )}
      </div>

      <CsrDialog open={dialog === 'csr'} hostname={data.hostname} current={cur} onClose={() => setDialog(null)} onDone={(ok) => after(ok)} />
      <InstallDialog open={dialog === 'install'} hostname={data.hostname} onClose={() => setDialog(null)} onDone={(ok) => after(ok)} />
      <UploadDialog open={dialog === 'upload'} hostname={data.hostname} onClose={() => setDialog(null)} onDone={(ok) => after(ok)} />
      <SelfSignedDialog open={dialog === 'self'} hostname={data.hostname} current={cur} onClose={() => setDialog(null)} onDone={(ok) => after(ok)} />
      <ConfirmDialog
        open={dialog === 'rollback'}
        onClose={() => setDialog(null)}
        title="Roll back the certificate?"
        confirmLabel="Roll back"
        message={
          data.previous
            ? `The portal goes back to ${data.previous.leaf.subject} (issued by ${data.previous.leaf.issuer}, valid until ${dateTime(data.previous.leaf.notAfter)}). The current one becomes the previous certificate, so this can be undone.`
            : ''
        }
        onConfirm={() => run(() => api.post('/api/admin/certificate/rollback'), 'Certificate rolled back').then(after)}
      />
      <ConfirmDialog
        open={dialog === 'discard'}
        onClose={() => setDialog(null)}
        danger
        title="Discard the certificate request?"
        confirmLabel="Discard"
        message="The pending key is deleted. A certificate your CA issues for this CSR can then no longer be installed."
        onConfirm={() => run(() => api.del('/api/admin/certificate/csr'), 'Request discarded').then(after)}
      />
    </section>
  );
}

type DialogProps = { open: boolean; hostname: string; onClose: () => void; onDone: (ok: unknown) => void };

function CsrDialog({ open, hostname, current, onClose, onDone }: DialogProps & { current?: CertInfo }) {
  const run = useAction();
  const [f, setF] = useState({
    commonName: hostname,
    altNames: (current?.names ?? []).filter((n) => n !== hostname).join('\n'),
    organization: '',
    organizationalUnit: '',
    locality: '',
    state: '',
    country: '',
    keyType: 'rsa-2048',
  });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate a certificate request (CSR)"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={busy || !f.commonName.trim()}
            onClick={async () => {
              setBusy(true);
              const ok = await run(
                () =>
                  api.post('/api/admin/certificate/csr', {
                    ...f,
                    altNames: splitNames(f.altNames),
                    ...Object.fromEntries(['organization', 'organizationalUnit', 'locality', 'state', 'country'].map((k) => [k, f[k as keyof typeof f] || undefined])),
                  }),
                'CSR generated',
              );
              setBusy(false);
              onDone(ok);
            }}
          >
            {busy && <Spinner />} Generate
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Common name *" help="Usually the portal's DNS name.">
          <input className="input font-mono" value={f.commonName} onChange={(e) => set({ commonName: e.target.value })} />
        </Field>
        <Field label="Additional names" help={`Other DNS names or IP addresses users type, e.g. an alias. One per line. ${hostname} is always included.`}>
          <textarea className="input min-h-20 font-mono" value={f.altNames} onChange={(e) => set({ altNames: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Organization">
            <input className="input" value={f.organization} onChange={(e) => set({ organization: e.target.value })} />
          </Field>
          <Field label="Organizational unit">
            <input className="input" value={f.organizationalUnit} onChange={(e) => set({ organizationalUnit: e.target.value })} />
          </Field>
          <Field label="City / locality">
            <input className="input" value={f.locality} onChange={(e) => set({ locality: e.target.value })} />
          </Field>
          <Field label="State / province">
            <input className="input" value={f.state} onChange={(e) => set({ state: e.target.value })} />
          </Field>
          <Field label="Country" help="Two letters, e.g. US.">
            <input className="input" maxLength={2} value={f.country} onChange={(e) => set({ country: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Key">
            <select className="input" value={f.keyType} onChange={(e) => set({ keyType: e.target.value })}>
              {KEY_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function PemInput({ label, value, onChange, accept }: { label: string; value: string; onChange: (v: string) => void; accept: string }) {
  return (
    <Field label={label} help="Paste the PEM text, or choose the file.">
      <textarea className="input min-h-28 font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} placeholder="-----BEGIN ..." />
      <input
        type="file"
        accept={accept}
        className="mt-2 text-xs text-slate-400"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) onChange(accept.includes('.key') ? await file.text() : await readCertificateFile(file));
        }}
      />
    </Field>
  );
}

function InstallDialog({ open, hostname, onClose, onDone }: DialogProps) {
  const run = useAction();
  const [pem, setPem] = useState('');
  const [other, setOther] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Install the signed certificate"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={busy || !pem.includes('BEGIN CERTIFICATE')}
            onClick={async () => {
              setBusy(true);
              const ok = await run(() => api.post('/api/admin/certificate/install', { certificate: pem, allowOtherName: other }), 'Certificate installed');
              setBusy(false);
              if (ok) setPem('');
              onDone(ok);
            }}
          >
            {busy && <Spinner />} Install
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <PemInput label="Certificate and chain" value={pem} onChange={setPem} accept=".crt,.cer,.pem,.der" />
        <p className="text-xs text-slate-400">
          Include the intermediate certificates (any order). The portal checks that the certificate matches the pending key, is valid now and names {hostname},
          then switches to it. The current certificate is kept for a roll back.
        </p>
        <Toggle checked={other} onChange={setOther} label={`Allow a certificate that doesn't name ${hostname}`} />
      </div>
    </Modal>
  );
}

function UploadDialog({ open, hostname, onClose, onDone }: DialogProps) {
  const run = useAction();
  const [tab, setTab] = useState<'pem' | 'pfx'>('pem');
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [pfx, setPfx] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [other, setOther] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = tab === 'pem' ? cert.includes('BEGIN CERTIFICATE') && key.includes('PRIVATE KEY') : Boolean(pfx);
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Upload a certificate and its private key"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={busy || !ready}
            onClick={async () => {
              setBusy(true);
              const body =
                tab === 'pem'
                  ? { certificate: cert, privateKey: key, passphrase: pass || undefined, allowOtherName: other }
                  : { pfxBase64: pfx, passphrase: pass, allowOtherName: other };
              const ok = await run(() => api.post('/api/admin/certificate/upload', body), 'Certificate installed');
              setBusy(false);
              if (ok) {
                setCert('');
                setKey('');
                setPfx(null);
                setPass('');
              }
              onDone(ok);
            }}
          >
            {busy && <Spinner />} Install
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-400">For a certificate issued elsewhere, with its key. Prefer Generate CSR when you can: the key then never leaves the portal.</p>
        <Tabs<'pem' | 'pfx'>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'pem', label: 'PEM files' },
            { id: 'pfx', label: 'PFX / PKCS#12' },
          ]}
        />
        {tab === 'pem' ? (
          <>
            <PemInput label="Certificate and chain" value={cert} onChange={setCert} accept=".crt,.cer,.pem,.der" />
            <PemInput label="Private key" value={key} onChange={setKey} accept=".key,.pem" />
            <Field label="Key passphrase" help="Only if the key is encrypted.">
              <input className="input" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="PFX file">
              <input
                type="file"
                accept=".pfx,.p12"
                className="text-sm text-slate-300"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return setPfx(null);
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  let bin = '';
                  bytes.forEach((b) => (bin += String.fromCharCode(b)));
                  setPfx(btoa(bin));
                }}
              />
            </Field>
            <Field label="PFX password">
              <input className="input" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
            </Field>
          </>
        )}
        <Toggle checked={other} onChange={setOther} label={`Allow a certificate that doesn't name ${hostname}`} />
      </div>
    </Modal>
  );
}

function SelfSignedDialog({ open, hostname, current, onClose, onDone }: DialogProps & { current?: CertInfo }) {
  const run = useAction();
  const [names, setNames] = useState((current?.names ?? []).filter((n) => n !== hostname).join('\n'));
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Regenerate the self-signed certificate"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await run(() => api.post('/api/admin/certificate/self-signed', { altNames: splitNames(names) }), 'Self-signed certificate installed');
              setBusy(false);
              onDone(ok);
            }}
          >
            {busy && <Spinner />} Regenerate
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-400">
          A new key and a certificate for {hostname}, valid 825 days. Browsers warn until they're told to trust it. The current certificate is kept for a roll back.
        </p>
        <Field label="Additional names" help="Other DNS names or IP addresses, one per line.">
          <textarea className="input min-h-20 font-mono" value={names} onChange={(e) => setNames(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
