import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import './index.css';
import { AppProvider, useApp } from './lib/app-context';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { DeployLab } from './pages/DeployLab';
import { LabDetail } from './pages/LabDetail';
import { Activity, JobPage } from './pages/Activity';
import { NetworkPool } from './pages/NetworkPool';
import { Account } from './pages/Account';
import { Help } from './pages/Help';
import { Users } from './pages/admin/Users';
import { ConfigDetail, Configs } from './pages/admin/Configs';
import { Settings } from './pages/admin/Settings';
import { AdminLabs, Audit } from './pages/admin/Misc';
import { CapacityProfiles, HolorouterDetail, Holorouters } from './pages/admin/Holorouters';

function RequireUser({ children }: { children: ReactNode }) {
  const { user, ready } = useApp();
  const location = useLocation();
  if (!ready) return <div className="grid h-full place-items-center"><Spinner className="size-6" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useApp();
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Toasts() {
  const { toasts, dismissToast } = useApp();
  const icon = { success: <CheckCircle2 className="size-4 text-emerald-400" />, error: <XCircle className="size-4 text-red-400" />, info: <Info className="size-4 text-sky-400" /> };
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="panel pointer-events-auto flex items-start gap-3 bg-ink-800 px-4 py-3 shadow-2xl">
          {icon[t.kind]}
          <span className="flex-1 text-sm text-slate-100">{t.text}</span>
          <button onClick={() => dismissToast(t.id)} className="text-slate-500 hover:text-white" aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireUser>
              <Layout />
            </RequireUser>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="labs/new" element={<DeployLab />} />
          <Route path="labs/:id" element={<LabDetail />} />
          <Route path="jobs/:id" element={<JobPage />} />
          <Route path="activity" element={<Activity />} />
          <Route path="network" element={<NetworkPool />} />
          <Route path="account" element={<Account />} />
          <Route path="help" element={<Help />} />
          <Route path="help/:guide" element={<Help />} />
          <Route path="help/:guide/:section" element={<Help />} />
          <Route path="admin/labs" element={<RequireAdmin><AdminLabs /></RequireAdmin>} />
          <Route path="admin/configs" element={<RequireAdmin><Configs /></RequireAdmin>} />
          <Route path="admin/configs/:id" element={<RequireAdmin><ConfigDetail /></RequireAdmin>} />
          <Route path="admin/users" element={<RequireAdmin><Users /></RequireAdmin>} />
          <Route path="admin/settings" element={<RequireAdmin><Settings /></RequireAdmin>} />
          <Route path="admin/holorouters" element={<RequireAdmin><Holorouters /></RequireAdmin>} />
          <Route path="admin/holorouters/:id" element={<RequireAdmin><HolorouterDetail /></RequireAdmin>} />
          <Route path="admin/profiles" element={<RequireAdmin><CapacityProfiles /></RequireAdmin>} />
          <Route path="admin/holorouter" element={<Navigate to="/admin/holorouters" replace />} />
          <Route path="admin/audit" element={<RequireAdmin><Audit /></RequireAdmin>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toasts />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppProvider>
  </StrictMode>,
);
