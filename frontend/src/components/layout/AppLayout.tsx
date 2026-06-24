import { Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { useAuthStore } from '../../store/authStore';

export function AppLayout() {
  const { user } = useAuthStore();
  const location = useLocation();

  if (!user) {
    return (
      <>
        <Header />
        <div key={location.pathname} className="route-fade"><Outlet /></div>
      </>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header />
        <main key={location.pathname} className="route-fade flex-1 flex flex-col overflow-auto pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0">
          <Outlet />
        </main>
      </div>
      <MobileNav />
    </div>
  );
}

export function PublicLayout() {
  const location = useLocation();
  return (
    <>
      <Header />
      <div key={location.pathname} className="route-fade"><Outlet /></div>
    </>
  );
}
