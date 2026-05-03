import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { applyTheme, getStoredTheme, storeTheme } from '../lib/theme';

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

  useEffect(() => {
    applyTheme(themeColor);
  }, [themeColor]);

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
