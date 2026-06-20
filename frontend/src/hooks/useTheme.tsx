import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { applyTheme, getStoredTheme, storeTheme } from '../lib/theme';
import { useAuthStore } from '../store/authStore';
import { api } from '../api/client';

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
    // Persist through the shared API client (consistent auth + error/401 handling).
    if (localStorage.getItem('5cd-single-token')) {
      api.updateTheme(hex).catch(() => {});
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
