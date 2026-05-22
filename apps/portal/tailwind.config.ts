import type { Config } from 'tailwindcss';

/**
 * Visual system — modern white-canvas dashboard with DankDash green as
 * the single accent. The brand green is `moss.500 = #3C9322`. Surfaces
 * stay white; structure comes from hair-thin slate borders, not
 * coloured backgrounds.
 *
 *   moss.50   #F1F8ED   tinted backgrounds for active nav, success pills
 *   moss.100  #DDEFCF   hover wash, soft chip backgrounds
 *   moss.500  #3C9322   brand green — primary buttons, active state, links
 *   moss.600  #2F7619   hover on primary button
 *   moss.700  #1F5410   deep contrast — focused borders, brand wordmark
 *
 *   slate.*  (Tailwind defaults) used for everything else — bg, borders,
 *   secondary text. We do NOT redefine slate; we lean on Tailwind's
 *   shipped palette so future components compose without re-aliasing.
 *
 *   ember/warning/danger preserved for status badges:
 *     ember   #C75D2C   "behind" / past-SLA, payment failed
 *     warning #C7A03C   slowing, needs attention
 *
 * CSS variables for the time-since-placed stale-order badges (Phase 14)
 * are declared in globals.css; the Tailwind tokens just expose them so
 * `bg-time-green` etc. compile.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}', './app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        moss: {
          50: '#F1F8ED',
          100: '#DDEFCF',
          200: '#BFE0A7',
          300: '#9AD081',
          400: '#6FBC4F',
          500: '#3C9322',
          600: '#2F7619',
          700: '#1F5410',
          800: '#16400B',
          900: '#0E2A07',
          DEFAULT: '#3C9322',
        },
        ember: '#C75D2C',
        warning: '#C7A03C',
        time: {
          green: 'var(--time-green)',
          yellow: 'var(--time-yellow)',
          red: 'var(--time-red)',
        },
      },
      fontFamily: {
        sans: [
          'var(--font-inter)',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'var(--font-jetbrains-mono)',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.02em' }],
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      boxShadow: {
        // very light card; meant to hint at elevation, not announce it.
        sm: '0 1px 2px rgb(15 23 42 / 0.04)',
        // hover/focused card.
        md: '0 4px 12px -2px rgb(15 23 42 / 0.06), 0 2px 4px -2px rgb(15 23 42 / 0.04)',
        // dropdown / popover.
        lg: '0 12px 32px -8px rgb(15 23 42 / 0.12), 0 4px 8px -4px rgb(15 23 42 / 0.06)',
        // dialog / command palette.
        xl: '0 24px 64px -12px rgb(15 23 42 / 0.18), 0 8px 16px -8px rgb(15 23 42 / 0.08)',
        // inner focus ring on inputs (Tailwind's ring + custom soft outer).
        ring: '0 0 0 4px rgb(60 147 34 / 0.12)',
      },
      transitionTimingFunction: {
        'out-quint': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-down': {
          '0%': { opacity: '0', transform: 'translateY(-4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'slide-down': 'slide-down 160ms cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
