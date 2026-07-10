import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { Icon } from '../Icon';

const NAV_ITEMS = [
  { path: '/dashboard', icon: 'folder_open', label: 'My Designs' },
  { path: '/create', icon: 'dashboard_customize', label: 'New Design' },
  { path: '/vectorize', icon: 'polyline', label: 'Vectorise' },
  { path: '/billing', icon: 'payments', label: 'Billing' },
  { path: '/settings', icon: 'settings', label: 'Settings' },
];

const DOCK_KEY = '5cd-sidebar-docked';

export function Sidebar() {
  const location = useLocation();
  const { user } = useAuthStore();
  // Manual preference wins; otherwise the studio auto-docks the sidebar to a
  // slim icon rail so the editor canvas gets the width.
  const [pref, setPref] = useState<boolean | null>(() => {
    const v = localStorage.getItem(DOCK_KEY);
    return v === null ? null : v === '1';
  });
  const onStudio = location.pathname.startsWith('/studio');
  const docked = pref ?? onStudio;

  const toggle = () => {
    const next = !docked;
    setPref(next);
    localStorage.setItem(DOCK_KEY, next ? '1' : '0');
  };

  if (docked) {
    return (
      <aside className="hidden lg:flex flex-col h-screen w-16 bg-surface-container-low sticky top-0 z-40 py-4 px-2 gap-1 items-center">
        <Link to="/dashboard" className="font-headline font-black text-on-surface text-xl tracking-tighter mb-6" title="5cd">
          5<span className="text-primary">.</span>
        </Link>
        <nav className="flex-1 flex flex-col gap-1 items-center">
          {NAV_ITEMS.map((item) => {
            const isActive =
              location.pathname === item.path ||
              (item.path === '/dashboard' &&
                (location.pathname.startsWith('/studio') || location.pathname.startsWith('/export')));
            return (
              <Link key={item.label} to={item.path} aria-current={isActive ? 'page' : undefined} title={item.label}
                className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${
                  isActive
                    ? 'bg-primary-container text-on-primary-container'
                    : 'text-on-surface-variant hover:bg-surface-container-high'
                }`}>
                <Icon name={item.icon} filled={isActive} label={item.label} />
              </Link>
            );
          })}
        </nav>
        <Link to="/billing" title={`${user?.credits ?? 0} credits — buy more`}
          className="w-11 py-2 rounded-xl bg-surface-container-lowest flex flex-col items-center gap-0.5 hover:bg-surface-container-high transition-colors">
          <Icon name="toll" className="text-sm text-primary" />
          <span className="font-headline font-bold text-[11px] leading-none">{user?.credits ?? 0}</span>
        </Link>
        <button onClick={toggle} title="Expand menu" aria-label="Expand menu"
          className="w-11 h-9 mt-1 rounded-xl flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high">
          <Icon name="left_panel_open" className="text-lg" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="hidden lg:flex flex-col h-screen w-64 bg-surface-container-low sticky top-0 z-40 p-4 gap-2">
      <div className="mb-8 px-2 flex items-center justify-between">
        <Link to="/dashboard" className="font-headline font-black text-on-surface text-2xl tracking-tighter">5cd</Link>
        <button onClick={toggle} title="Dock menu (more room for the canvas)" aria-label="Dock menu"
          className="w-9 h-9 rounded-xl flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high">
          <Icon name="left_panel_close" className="text-lg" />
        </button>
      </div>

      <nav className="flex-1 flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const isActive =
            location.pathname === item.path ||
            (item.path === '/dashboard' &&
              (location.pathname.startsWith('/studio') || location.pathname.startsWith('/export')));
          return (
            <Link key={item.label} to={item.path} aria-current={isActive ? 'page' : undefined}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
                isActive
                  ? 'bg-primary-container text-on-primary-container font-bold'
                  : 'text-on-surface hover:bg-surface-container-high hover:translate-x-1 transition-all'
              }`}>
              <Icon name={item.icon} filled={isActive} />
              <span className="font-label uppercase text-xs tracking-widest">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto pt-6 border-t border-outline-variant/10">
        <div className="bg-surface-container-lowest p-4 rounded-2xl shadow-[0_20px_40px_rgba(30,30,30,0.06)] relative overflow-hidden group">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-primary-container/30 rounded-full blur-2xl group-hover:bg-primary-container/50 transition-colors" />
          <p className="font-label text-[10px] uppercase tracking-tighter text-on-surface-variant mb-1">Current Balance</p>
          <div className="flex items-end justify-between">
            <span className="font-headline font-extrabold text-2xl text-on-surface">{user?.credits ?? 0}</span>
            <span className="font-label text-xs text-on-surface-variant">credits</span>
          </div>
        </div>
        <Link to="/billing"
          className="block w-full mt-4 bg-primary-container text-on-primary-container font-headline font-bold py-3 rounded-xl hover:scale-[1.02] active:scale-95 transition-all text-center text-sm">
          Buy Credits
        </Link>
      </div>
    </aside>
  );
}
