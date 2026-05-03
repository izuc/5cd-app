export interface ThemeColors {
  primary: string;
  primaryDim: string;
  primaryContainer: string;
  onPrimary: string;
  onPrimaryContainer: string;
  primaryFixed: string;
  primaryFixedDim: string;
  inversePrimary: string;
  onPrimaryFixed: string;
  onPrimaryFixedVariant: string;
}

export const THEME_PRESETS: Record<string, { label: string; hex: string }> = {
  emerald: { label: 'Emerald', hex: '#059669' },
  ocean: { label: 'Ocean', hex: '#0284c7' },
  violet: { label: 'Violet', hex: '#7c3aed' },
  rose: { label: 'Rose', hex: '#e11d48' },
  amber: { label: 'Amber', hex: '#d97706' },
  slate: { label: 'Slate', hex: '#475569' },
};

function hexToHSL(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  h = h / 360;
  s = s / 100;
  l = l / 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (c: number) => {
    const hex = Math.round(c * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function generateThemeColors(baseHex: string): ThemeColors {
  const [h, s, l] = hexToHSL(baseHex);
  return {
    primary: baseHex,
    primaryDim: hslToHex(h, Math.min(s + 5, 100), Math.max(l - 10, 10)),
    primaryContainer: hslToHex(h, Math.min(s * 0.6, 80), Math.min(l + 35, 88)),
    onPrimary: hslToHex(h, Math.min(s * 0.3, 30), Math.min(l + 45, 97)),
    onPrimaryContainer: hslToHex(h, Math.min(s + 5, 100), Math.max(l - 25, 8)),
    primaryFixed: hslToHex(h, Math.min(s * 0.7, 85), Math.min(l + 25, 78)),
    primaryFixedDim: hslToHex(h, Math.min(s * 0.8, 90), Math.min(l + 15, 65)),
    inversePrimary: hslToHex(h, Math.min(s * 0.7, 85), Math.min(l + 25, 78)),
    onPrimaryFixed: hslToHex(h, Math.min(s + 10, 100), Math.max(l - 35, 5)),
    onPrimaryFixedVariant: hslToHex(h, Math.min(s + 5, 100), Math.max(l - 15, 12)),
  };
}

export function applyTheme(baseHex: string): void {
  const colors = generateThemeColors(baseHex);
  const root = document.documentElement;
  root.classList.add('theme-transitioning');
  root.style.setProperty('--color-primary', colors.primary);
  root.style.setProperty('--color-primary-dim', colors.primaryDim);
  root.style.setProperty('--color-primary-container', colors.primaryContainer);
  root.style.setProperty('--color-on-primary', colors.onPrimary);
  root.style.setProperty('--color-on-primary-container', colors.onPrimaryContainer);
  root.style.setProperty('--color-primary-fixed', colors.primaryFixed);
  root.style.setProperty('--color-primary-fixed-dim', colors.primaryFixedDim);
  root.style.setProperty('--color-inverse-primary', colors.inversePrimary);
  root.style.setProperty('--color-on-primary-fixed', colors.onPrimaryFixed);
  root.style.setProperty('--color-on-primary-fixed-variant', colors.onPrimaryFixedVariant);
  setTimeout(() => root.classList.remove('theme-transitioning'), 350);
}

export function getStoredTheme(): string {
  return localStorage.getItem('5cd-single-theme-color') || '#059669';
}

export function storeTheme(hex: string): void {
  localStorage.setItem('5cd-single-theme-color', hex);
}
