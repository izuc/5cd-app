import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { applyTheme, getStoredTheme, storeTheme } from '../lib/theme';
import { useAuthStore } from '../store/authStore';

interface ThemeContextValue {
  themeColor: string;
  setThemeColor: (hex: string) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  themeColor: '#059669',
  setThemeColor: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeColor, setThemeColorState] = useState(getStoredTheme);
  const userThemeColor = useAuthStore((s) => s.user?.theme_color);

  useEffect(() => {
    applyTheme(themeColor);
  }, [themeColor]);

  // When the signed-in user's saved theme loads, make it the source of truth
  // (without re-PATCHing the server).
  useEffect(() => {
    if (userThemeColor) {
      setThemeColorState(userThemeColor);
      storeTheme(userThemeColor);
    }
  }, [userThemeColor]);

  const setThemeColor = (hex: string) => {
    setThemeColorState(hex);
    storeTheme(hex);
    const token = localStorage.getItem('5cd-single-token');
    if (token) {
      fetch('/api/user/theme', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ theme_color: hex }),
      }).catch(() => {});
    }
  };

  return (
    <ThemeContext.Provider value={{ themeColor, setThemeColor }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
