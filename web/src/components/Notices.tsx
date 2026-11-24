import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';

/** Dashboard notices: Dismiss hides one until the next sign-in; Don't show again is kept on the account. */
export function Notices() {
  const { meta } = useApp();
  const [hidden, setHidden] = useState<string[]>(() => Object.keys(sessionStorage).filter((k) => k.startsWith('hp.notice.')).map((k) => k.slice(10)));
  const list = (meta?.notices ?? []).filter((n) => !hidden.includes(n.id));
  if (!list.length) return null;
  const hide = (id: string) => setHidden((h) => [...h, id]);
  return (
    <div className="mb-5 space-y-3">
      {list.map((n) => (
        <div key={n.id} className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="font-medium text-amber-200">{n.title}</div>
              <p className="text-amber-100/90">{n.message}</p>
              {n.warning && <p className="font-medium text-amber-200">{n.warning}</p>}
              <div className="flex flex-wrap gap-3 pt-1 text-xs">
                <Link to="/admin/settings" className="text-amber-200 underline hover:text-white">
                  Open Settings
                </Link>
                <button
                  className="text-amber-200 underline hover:text-white"
                  onClick={() => {
                    sessionStorage.setItem(`hp.notice.${n.id}`, '1');
                    hide(n.id);
                  }}
                >
                  Dismiss
                </button>
                {n.id !== 'powercli' && (
                  <button
                    className="text-amber-200 underline hover:text-white"
                    onClick={() => {
                      hide(n.id);
                      void api.post(`/api/notices/${n.id}/dismiss`).catch(() => undefined);
                    }}
                  >
                    Don&apos;t show again
                  </button>
                )}
              </div>
            </div>
            <button
              className="rounded p-1 text-amber-300 hover:bg-amber-500/20"
              title="Dismiss until the next sign-in"
              onClick={() => {
                sessionStorage.setItem(`hp.notice.${n.id}`, '1');
                hide(n.id);
              }}
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
