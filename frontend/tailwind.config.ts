import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'primary': 'var(--color-primary)',
        'primary-dim': 'var(--color-primary-dim)',
        'primary-container': 'var(--color-primary-container)',
        'on-primary': 'var(--color-on-primary)',
        'on-primary-container': 'var(--color-on-primary-container)',
        'primary-fixed': 'var(--color-primary-fixed)',
        'primary-fixed-dim': 'var(--color-primary-fixed-dim)',
        'inverse-primary': 'var(--color-inverse-primary)',
        'on-primary-fixed': 'var(--color-on-primary-fixed)',
        'on-primary-fixed-variant': 'var(--color-on-primary-fixed-variant)',

        'secondary': '#0891b2',
        'secondary-dim': '#0e7490',
        'secondary-container': '#22d3ee',
        'on-secondary': '#ecfeff',
        'on-secondary-container': '#164e63',

        'tertiary': '#e11d48',
        'tertiary-container': '#fda4af',
        'on-tertiary-container': '#881337',

        'surface': '#f9f6f5',
        'surface-bright': '#f9f6f5',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#f3f0ef',
        'surface-container': '#eae7e7',
        'surface-container-high': '#e5e2e1',
        'surface-container-highest': '#dfdcdc',
        'surface-variant': '#dfdcdc',

        'on-surface': '#1e1e1e',
        'on-surface-variant': '#5c5b5b',
        'background': '#f9f6f5',

        'outline': '#787676',
        'outline-variant': '#afacac',

        'error': '#b02500',
        'error-container': '#f95630',
        'on-error': '#ffefec',
        'on-error-container': '#520c00',
      },
      fontFamily: {
        headline: ['Plus Jakarta Sans', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
        label: ['Space Grotesk', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.5rem',
        xl: '0.75rem',
        '2xl': '1rem',
        '3xl': '1.5rem',
        full: '9999px',
      },
    },
  },
  plugins: [],
} satisfies Config;
