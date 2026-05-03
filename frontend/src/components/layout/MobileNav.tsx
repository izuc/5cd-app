import { Link, useLocation } from 'react-router-dom';
import { Icon } from '../Icon';

const NAV_ITEMS = [
  { path: '/dashboard', icon: 'folder_open', label: 'Designs' },
  { path: '/create', icon: 'add', label: 'Create', isCreate: true },
  { path: '/billing', icon: 'payments', label: 'Billing' },
  { path: '/settings', icon: 'settings', label: 'Settings' },
];

export function MobileNav() {
  const location = useLocation();

  return (
    <nav aria-label="Main navigation" className="lg:hidden fixed bottom-0 left-0 right-0 bg-surface/80 backdrop-blur-xl z-50 px-4 py-3 flex justify-between items-center border-t border-outline-variant/10 safe-area-bottom">
      {NAV_ITEMS.map((item) => {
        const isActive = location.pathname === item.path && !item.isCreate;
        if (item.isCreate) {
          return (
            <div key={item.label} className="relative -top-5">
              <Link to={item.path} className="w-14 h-14 bg-primary-container rounded-full shadow-2xl flex items-center justify-center text-on-primary-container">
                <Icon name="add" className="text-3xl" />
              </Link>
            </div>
          );
        }
        return (
          <Link key={item.label} to={item.path} className={`flex flex-col items-center gap-1 ${isActive ? 'text-primary' : 'text-on-surface-variant'}`}>
            <Icon name={item.icon} filled={isActive} />
            <span className="text-[10px] font-label font-bold">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
