import { useState } from 'react';
import { BookOpen, ExternalLink, FileText, FolderGit2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { Modal, Spinner } from './ui';
import { UpdatesPanel } from './UpdatesPanel';

interface About {
  product: string;
  version: string;
  repository: string;
  license: string;
  copyright: string;
  disclaimer: string;
  notices: boolean;
  build?: { commit: string | null; formFactor: 'appliance' | 'container' | 'host'; node: string; powercli?: { state: string; version: string; message: string } | null };
  holodeckVersions?: { version: string; routers: number }[];
}

const FORM_FACTOR: Record<string, string> = { appliance: 'Appliance (Photon OS)', container: 'Container', host: 'Installed on a host' };

/** Product name, version, licence, links; build details for administrators. */
export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useApi<About>(open ? '/api/about' : null);
  const [notices, setNotices] = useState<string | null>(null);
  const showNotices = async () => {
    const res = await fetch('/api/about/notices', { credentials: 'same-origin' });
    setNotices(res.ok ? await res.text() : 'No third-party notices in this build.');
  };
  // The repository link is a placeholder until the public repository exists.
  const placeholderRepo = data?.repository.includes('<');
  return (
    <Modal open={open} onClose={() => (setNotices(null), onClose())} title={notices ? 'Third-party notices' : 'About'} wide={Boolean(notices)}>
      {!data ? (
        <Spinner />
      ) : notices ? (
        <div>
          <button className="btn-ghost mb-3 -ml-2" onClick={() => setNotices(null)}>
            ← Back
          </button>
          <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-lg bg-ink-900 p-3 font-mono text-xs text-slate-300">{notices}</pre>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div>
            <div className="text-lg font-semibold text-white">{data.product}</div>
            <div className="text-slate-400">
              Version <span className="font-mono text-slate-200">{data.version}</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <FolderGit2 className="size-4 text-slate-500" />
              {placeholderRepo ? (
                <span className="text-slate-400">Source repository: coming soon</span>
              ) : (
                <a className="text-blue-300 hover:underline" href={data.repository} target="_blank" rel="noreferrer">
                  {data.repository.replace(/^https?:\/\//, '')} <ExternalLink className="inline size-3" />
                </a>
              )}
            </div>
            <div className="flex items-center gap-2">
              <BookOpen className="size-4 text-slate-500" />
              <Link className="text-blue-300 hover:underline" to="/help" onClick={onClose}>
                User and administrator guides
              </Link>
            </div>
            {data.notices && (
              <div className="flex items-center gap-2">
                <FileText className="size-4 text-slate-500" />
                <button className="text-blue-300 hover:underline" onClick={() => void showNotices()}>
                  Third-party notices
                </button>
              </div>
            )}
          </div>
          <div className="text-slate-400">
            <div>
              {data.copyright}. Released under the {data.license} License.
            </div>
            <div className="mt-1">{data.disclaimer}</div>
          </div>
          {data.build && (
            <div className="rounded-lg border border-ink-700 bg-ink-900 p-3">
              <div className="label-caps mb-2">Updates</div>
              <UpdatesPanel />
            </div>
          )}
          {data.build && (
            <div className="rounded-lg border border-ink-700 bg-ink-900 p-3">
              <div className="label-caps mb-2">Build (administrators)</div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-slate-500">Commit</dt>
                <dd className="font-mono text-slate-300">{data.build.commit ?? 'unknown'}</dd>
                <dt className="text-slate-500">Installed as</dt>
                <dd className="text-slate-300">{FORM_FACTOR[data.build.formFactor]}</dd>
                <dt className="text-slate-500">Node.js</dt>
                <dd className="font-mono text-slate-300">{data.build.node}</dd>
                {data.build.powercli && (
                  <>
                    <dt className="text-slate-500">PowerCLI</dt>
                    <dd className={data.build.powercli.state === 'ready' ? 'text-slate-300' : 'text-amber-300'}>
                      {data.build.powercli.version}{' '}
                      {data.build.powercli.state === 'ready' ? '' : data.build.powercli.state === 'installing' ? '(downloading…)' : '(download failed; retrying)'}
                    </dd>
                  </>
                )}
                <dt className="text-slate-500">Holodeck</dt>
                <dd className="text-slate-300">
                  {data.holodeckVersions?.length
                    ? data.holodeckVersions.map((h) => `${h.version} (${h.routers} router${h.routers === 1 ? '' : 's'})`).join(', ')
                    : 'no routers checked yet'}
                </dd>
              </dl>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
