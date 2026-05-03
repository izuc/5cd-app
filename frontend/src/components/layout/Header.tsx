import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { ThemeCustomizer } from '../ThemeCustomizer';
import { Icon } from '../Icon';

export function Header() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [showTheme, setShowTheme] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu]);

  return (
    <>
      <header className="bg-surface/80 backdrop-blur-xl sticky top-0 z-50 shadow-[0_20px_40px_rgba(30,30,30,0.06)]">
        <div className="flex justify-between items-center w-full px-4 sm:px-6 py-3 sm:py-4 max-w-[1920px] mx-auto relative">
          <Link to={user ? '/dashboard' : '/'} className="text-2xl font-black text-on-surface tracking-tighter font-headline">
            5cd
          </Link>

          <div className="flex items-center gap-2 sm:gap-4">
            {user ? (
              <>
                <div className="hidden sm:flex items-center px-3 py-1.5 bg-surface-container-high rounded-full">
                  <Icon name="toll" className="text-sm text-on-surface-variant mr-1.5" />
                  <span className="font-label text-xs font-bold text-on-surface">{user.credits} Credits</span>
                </div>
                <button onClick={() => setShowTheme(true)} className="p-2 rounded-full hover:bg-surface-container-high transition-colors hidden sm:flex" title="Customize theme" aria-label="Customize theme">
                  <Icon name="palette" className="text-on-surface-variant" />
                </button>
                <Link to="/create" className="bg-primary-container text-on-primary-container px-4 sm:px-6 py-2 rounded-xl font-headline font-bold text-sm hover:scale-105 active:scale-95 transition-all">
                  New Design
                </Link>
                <div className="relative" ref={menuRef}>
                  <button onClick={() => setShowMenu(!showMenu)} aria-label="User menu" aria-expanded={showMenu}
                    className="w-10 h-10 rounded-full bg-surface-variant overflow-hidden border-2 border-primary-container flex items-center justify-center">
                    <span className="font-headline font-bold text-sm text-on-surface-variant">
                      {user.display_name?.charAt(0)?.toUpperCase() || user.email.charAt(0).toUpperCase()}
                    </span>
                  </button>
                  {showMenu && (
                    <div className="absolute right-0 top-12 bg-surface-container-lowest rounded-xl shadow-xl border border-outline-variant/10 py-2 w-48 z-50">
                      <div className="px-4 py-2 border-b border-outline-variant/10">
                        <p className="font-headline font-bold text-sm truncate">{user.display_name || user.email}</p>
                        <p className="text-xs text-on-surface-variant truncate">{user.email}</p>
                        <div className="flex items-center gap-1.5 mt-1.5 sm:hidden">
                          <Icon name="toll" className="text-xs text-primary" />
                          <span className="font-label text-xs font-bold text-primary">{user.credits} Credits</span>
                        </div>
                      </div>
                      <Link to="/billing" onClick={() => setShowMenu(false)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container-low transition-colors text-sm">
                        <Icon name="payments" className="text-lg" /> Billing
                      </Link>
                      <Link to="/settings" onClick={() => setShowMenu(false)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container-low transition-colors text-sm">
                        <Icon name="settings" className="text-lg" /> Settings
                      </Link>
                      <button onClick={() => setShowTheme(true)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container-low transition-colors text-sm w-full sm:hidden">
                        <Icon name="palette" className="text-lg" /> Theme
                      </button>
                      <button onClick={() => { logout(); navigate('/'); setShowMenu(false); }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container-low transition-colors text-sm text-error w-full">
                        <Icon name="logout" className="text-lg" /> Log Out
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <Link to="/login" className="text-on-surface font-headline font-bold text-sm px-4 py-2 hover:text-primary transition-colors">Log In</Link>
                <Link to="/register" className="bg-primary-container text-on-primary-container px-6 py-2.5 rounded-xl font-headline font-bold text-sm hover:scale-105 active:scale-95 transition-all">Sign Up Free</Link>
              </>
            )}
          </div>

          <div className="bg-surface-container-low h-[1px] w-full absolute bottom-0 left-0" />
        </div>
      </header>
      {showTheme && <ThemeCustomizer onClose={() => setShowTheme(false)} />}
    </>
  );
}
