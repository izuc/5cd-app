import { Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { Icon } from '../Icon';

const NAV_ITEMS = [
  { path: '/dashboard', icon: 'folder_open', label: 'My Designs' },
  { path: '/create', icon: 'dashboard_customize', label: 'New Design' },
  { path: '/billing', icon: 'payments', label: 'Billing' },
  { path: '/settings', icon: 'settings', label: 'Settings' },
];

export function Sidebar() {
  const location = useLocation();
  const { user } = useAuthStore();

  return (
    <aside className="hidden lg:flex flex-col h-screen w-64 bg-surface-container-low sticky top-0 z-40 p-4 gap-2">
      <div className="mb-8 px-2">
        <Link to="/dashboard" className="font-headline font-black text-on-surface text-2xl tracking-tighter">5cd</Link>
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
