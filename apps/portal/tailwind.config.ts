import { tokens } from '@dankdash/design-tokens';
import type { Config } from 'tailwindcss';

/**
 * Portal visual system. Tokens come from `@dankdash/design-tokens` so
 * portal CSS, the iOS consumer app, and the Dasher driver app all share
 * the same source of truth — to change a brand value, edit
 * `packages/design-tokens/src/tokens.ts` and run
 * `pnpm --filter @dankdash/design-tokens build` (which also regenerates
 * the iOS Swift constants).
 *
 * Tailwind class names stay legible:
 *   bg-moss-500  → brand green (#3B9322), same as `DankColor.primary`
 *   bg-moss-50   → tinted background for active nav, success pills
 *   bg-moss-600  → hover state on primary buttons, same as `DankColor.primaryDark`
 *   text-ember   → past-SLA / payment failed
 *   text-warning → slowing, needs attention
 *
 * The `moss` alias predates the token package; new components should
 * prefer the `primary` alias (same scale) so future renames are
 * mechanical.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}', './app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        moss: {
          ...tokens.color.primary,
          DEFAULT: tokens.color.primary[500],
        },
        primary: {
          ...tokens.color.primary,
          DEFAULT: tokens.color.primary[500],
        },
        ember: tokens.color.status.ember,
        warning: tokens.color.status.attention,
        success: tokens.color.semantic.success,
        danger: tokens.color.semantic.danger,
        info: tokens.color.semantic.info,
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
        sm: tokens.shadow.sm.css,
        md: tokens.shadow.md.css,
        lg: tokens.shadow.lg.css,
        xl: tokens.shadow.xl.css,
        ring: tokens.shadow.ring.css,
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
