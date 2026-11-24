import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Activity,
  Bell,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Info,
  KeyRound,
  LayoutGrid,
  LogOut,
  Network,
  Plus,
  Layers,
  Router,
  ScrollText,
  Server,
  Settings,
  Users,
} from 'lucide-react';
import { useApp } from '../lib/app-context';
import { useApi, useLocalStorage, useNow } from '../lib/hooks';
import { api } from '../lib/api';
import { initials, relativeTime } from '../lib/format';
import type { NotificationItem } from '../lib/types';
import { AboutDialog } from './AboutDialog';

function Logo({ collapsed, name }: { collapsed: boolean; name: string }) {
  return (
    <div className="flex items-center gap-3">
      <img src="/favicon.svg" alt="" className="size-8 rounded-lg" />
      {!collapsed && <span className="truncate text-[17px] font-bold tracking-tight text-white">{name}</span>}
    </div>
  );
}

function NavItem({ to, icon, label, collapsed, end }: { to: string; icon: ReactNode; label: string; collapsed: boolean; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
          isActive ? 'bg-accent-soft/60 text-blue-300 ring-1 ring-accent/30' : 'text-slate-300 hover:bg-ink-700 hover:text-white'
        } ${collapsed ? 'justify-center px-0' : ''}`
      }
    >
      <span className="shrink-0 [&>svg]:size-[18px]">{icon}</span>
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
}

function SectionLabel({ children, collapsed }: { children: ReactNode; collapsed: boolean }) {
  if (collapsed) return <div className="mx-3 my-3 border-t border-ink-700" />;
  return <div className="label-caps mt-6 mb-2 px-3">{children}</div>;
}

function Clock({ collapsed }: { collapsed: boolean }) {
  const now = useNow(1000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const time = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (collapsed) return null;
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-2.5 text-center">
      <div className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase">{tz}</div>
      <div className="font-mono text-2xl text-blue-300 tabular-nums">{time}</div>
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi<{ items: NotificationItem[]; unread: number }>('/api/notifications', { interval: 30_000 });
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const tone = { info: 'bg-sky-400', success: 'bg-emerald-400', warning: 'bg-amber-400', error: 'bg-red-400' };
  return (
    <div className="relative" ref={ref}>
      <button className="relative rounded-lg p-1.5 text-slate-300 hover:bg-ink-700 hover:text-white" onClick={() => setOpen((o) => !o)} aria-label="Notifications">
        <Bell className="size-[18px]" />
        {!!data?.unread && (
          <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {data.unread > 9 ? '9+' : data.unread}
          </span>
        )}
      </button>
      {open && (
        <div className="panel absolute top-9 left-0 z-40 w-96 overflow-hidden bg-ink-850 shadow-2xl">
          <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
            <span className="text-sm font-semibold text-white">Notifications</span>
            <button
              className="text-xs text-blue-300 hover:underline"
              onClick={async () => {
                await api.post('/api/notifications/read');
                void reload();
              }}
            >
              Mark all read
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {data?.items.length ? (
              data.items.map((n) => (
                <button
                  key={n.id}
                  className={`flex w-full gap-3 border-b border-ink-700/60 px-4 py-3 text-left hover:bg-ink-800 ${n.readAt ? 'opacity-60' : ''}`}
                  onClick={async () => {
                    await api.post('/api/notifications/read', { ids: [n.id] });
                    void reload();
                    setOpen(false);
                    if (n.labId) navigate(`/labs/${n.labId}`);
                  }}
                >
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${tone[n.level]}`} />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-100">{n.title}</span>
                    {n.message && <span className="block text-xs text-slate-400">{n.message}</span>}
                    <span className="mt-0.5 block text-[11px] text-slate-500">{relativeTime(n.createdAt)}</span>
                  </span>
                </button>
              ))
            ) : (
              <div className="px-4 py-8 text-center text-sm text-slate-500">You're all caught up.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { user, logout } = useApp();
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState(false);
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="grid size-10 place-items-center rounded-full border border-ink-600 bg-ink-800 text-sm font-semibold text-slate-100 hover:border-ink-500"
        title={`${user.firstName} ${user.lastName}`}
      >
        {initials(user.firstName, user.lastName, user.username)}
      </button>
      {open && (
        <div className={`panel absolute bottom-12 z-40 w-60 bg-ink-850 p-2 shadow-2xl ${collapsed ? 'left-0' : 'right-0'}`} onMouseLeave={() => setOpen(false)}>
          <div className="px-3 py-2">
            <div className="text-sm font-medium text-white">
              {user.firstName} {user.lastName}
            </div>
            <div className="text-xs text-slate-400">
              {user.username} · {user.role === 'admin' ? 'Administrator' : 'User'}
            </div>
          </div>
          {user.authSource === 'local' && (
            <button className="btn-ghost w-full justify-start" onClick={() => (setOpen(false), navigate('/account'))}>
              <KeyRound className="size-4" /> Account
            </button>
          )}
          <button className="btn-ghost w-full justify-start" onClick={() => (setOpen(false), setAbout(true))}>
            <Info className="size-4" /> About
          </button>
          <button className="btn-ghost w-full justify-start" onClick={() => void logout().then(() => navigate('/login'))}>
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
      <AboutDialog open={about} onClose={() => setAbout(false)} />
    </div>
  );
}

export function Layout() {
  const { user, meta } = useApp();
  const [collapsed, setCollapsed] = useLocalStorage('hp.sidebar.collapsed', false);
  const isAdmin = user?.role === 'admin';
  const name = meta?.portalName ?? 'Holodeck Portal';

  return (
    <div className="flex h-full">
      <aside className={`flex shrink-0 flex-col border-r border-ink-700 bg-ink-900 transition-[width] duration-200 ${collapsed ? 'w-[76px]' : 'w-64'}`}>
        <div className="px-4 pt-5">
          <div className={`flex items-center ${collapsed ? 'flex-col gap-3' : 'justify-between'}`}>
            <Logo collapsed={collapsed} name={name} />
            <Notifications />
          </div>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="mt-4 flex w-full items-center justify-center rounded-lg border border-ink-700 bg-ink-850 py-1 text-slate-400 hover:text-white"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          </button>
        </div>

        <nav className="mt-2 flex-1 overflow-y-auto px-3 pb-4">
          <SectionLabel collapsed={collapsed}>Navigation</SectionLabel>
          <div className="space-y-1">
            <NavItem to="/" end icon={<LayoutGrid />} label="Dashboard" collapsed={collapsed} />
            <NavItem to="/labs/new" icon={<Plus />} label="Deploy a lab" collapsed={collapsed} />
            <NavItem to="/activity" icon={<Activity />} label="Activity" collapsed={collapsed} />
            <NavItem to="/network" icon={<Network />} label="Network pool" collapsed={collapsed} />
            <NavItem to="/help" icon={<BookOpen />} label="Documentation" collapsed={collapsed} />
          </div>
          {isAdmin && (
            <>
              <SectionLabel collapsed={collapsed}>Administration</SectionLabel>
              <div className="space-y-1">
                <NavItem to="/admin/labs" icon={<FlaskConical />} label="All labs" collapsed={collapsed} />
                <NavItem to="/admin/configs" icon={<Server />} label="Configurations" collapsed={collapsed} />
                <NavItem to="/admin/users" icon={<Users />} label="Users" collapsed={collapsed} />
                <NavItem to="/admin/holorouters" icon={<Router />} label="Holorouters" collapsed={collapsed} />
                <NavItem to="/admin/profiles" icon={<Layers />} label="Capacity profiles" collapsed={collapsed} />
                <NavItem to="/admin/settings" icon={<Settings />} label="Settings" collapsed={collapsed} />
                <NavItem to="/admin/audit" icon={<ScrollText />} label="Audit log" collapsed={collapsed} />
              </div>
            </>
          )}
        </nav>

        <div className={`flex items-center gap-3 border-t border-ink-700 p-4 ${collapsed ? 'justify-center' : ''}`}>
          <div className="flex-1">
            <Clock collapsed={collapsed} />
          </div>
          <UserMenu collapsed={collapsed} />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] px-6 py-8 lg:px-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
