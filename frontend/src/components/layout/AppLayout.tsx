import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { useAuthStore } from '../../store/authStore';

export function AppLayout() {
  const { user } = useAuthStore();

  if (!user) {
    return (
      <>
        <Header />
        <Outlet />
      </>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header />
        <main className="flex-1 flex flex-col overflow-auto pb-20 lg:pb-0">
          <Outlet />
        </main>
      </div>
      <MobileNav />
    </div>
  );
}

export function PublicLayout() {
  return (
    <>
      <Header />
      <Outlet />
    </>
  );
}
