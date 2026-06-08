/**
 * Canonical brand token vocabulary. This file is the *only* place where
 * literal hex values, spacing magnitudes, type sizes, and shadow recipes
 * are written by hand. The portal Tailwind config and the iOS Swift
 * design system both read from here (the iOS side via codegen).
 *
 * Adding or changing a token here is a brand decision — review with the
 * design owner, then run `pnpm --filter @dankdash/design-tokens build`
 * to regenerate `DankDashKit/Sources/DankDashDesignSystem/Generated/`
 * and commit both halves in the same logical change.
 */
export const tokens = {
  /**
   * Color palette. The `primary` scale 500 entry is the canonical
   * DankDash brand green (matches `AccentColor.colorset`). The 50-400
   * shades are tinted washes for surfaces / hover states / chips; 600+
   * are progressively darker for hover and deep contrast roles.
   */
  color: {
    primary: {
      50: '#F1F8ED',
      100: '#DDEFCF',
      200: '#BFE0A7',
      300: '#9AD081',
      400: '#6FBC4F',
      500: '#3B9322',
      600: '#256014',
      700: '#1F5410',
      800: '#16400B',
      900: '#0E2A07',
    },
    background: '#FFFFFF',
    glass: 'rgba(255, 255, 255, 0.08)',
    /**
     * Surface tones for layered backgrounds — replaces the slate-50/100/200/900
     * habits in the portal. The "muted" tint is intentionally green-shifted
     * (warm gray) rather than slate-cool so the portal feels in the same
     * brand family as the iOS apps, where the cream / off-white backgrounds
     * lean warm.
     */
    surface: {
      default: '#FFFFFF',
      muted: '#F7FAF6',
      subtle: '#EEF3EC',
      inverse: '#0F1A0D',
    },
    /**
     * Border tones. `default` is the everyday divider line (replaces
     * slate-200), `subtle` is the inner card-header rule (replaces
     * slate-100), `strong` is the focused/hovered border (replaces
     * slate-300).
     */
    border: {
      subtle: '#EEF1EC',
      default: '#DBE1D7',
      strong: '#B2BCAF',
    },
    /**
     * Semantic intent palette. Each role exposes a base color (used for
     * text + icon strokes against a white surface) and a soft variant
     * (used as a tinted background — pills, banners, alert rows).
     */
    semantic: {
      success: '#2E7D32',
      successSoft: '#E6F2E6',
      warning: '#B07A12',
      warningSoft: '#FBF1DA',
      danger: '#B3261E',
      dangerSoft: '#FBE6E5',
      info: '#1F4E8C',
      infoSoft: '#E2ECF8',
    },
    status: {
      ember: '#C75D2C',
      attention: '#C7A03C',
    },
    text: {
      primary: '#0F1A0D',
      secondary: '#4A5A4A',
      muted: '#7A8A7A',
      onPrimary: '#FFFFFF',
      onBackground: '#0F1A0D',
    },
  },

  /** 4-pt spacing scale. Numeric values are points (iOS) / pixels (web). */
  spacing: {
    xxs: 4,
    xs: 8,
    sm: 12,
    md: 16,
    lg: 20,
    xl: 28,
    xxl: 40,
  },

  /** Corner radius scale. `pill` exceeds any expected element height. */
  radius: {
    sm: 6,
    md: 12,
    lg: 20,
    pill: 999,
  },

  /**
   * Typography. Sizes are the default point size (.large Dynamic Type
   * on iOS, base rem on web). Weight + design field map to platform
   * font primitives in the codegen layer.
   */
  typography: {
    display: { size: 28, weight: 'bold', design: 'rounded' },
    title: { size: 22, weight: 'semibold', design: 'rounded' },
    headline: { size: 17, weight: 'semibold', design: 'default' },
    body: { size: 16, weight: 'regular', design: 'default' },
    bodySmall: { size: 13, weight: 'regular', design: 'default' },
    caption: { size: 12, weight: 'medium', design: 'default' },
    mono: { size: 13, weight: 'medium', design: 'monospaced' },
  },

  /**
   * Box / view shadows. Strings are CSS box-shadow recipes — web
   * consumes them directly via Tailwind; iOS uses the spacing/blur
   * fields for `.shadow(color:radius:x:y:)` calls.
   */
  shadow: {
    sm: {
      css: '0 1px 2px rgb(15 23 42 / 0.04)',
      ios: { color: 'rgba(15, 23, 42, 0.04)', radius: 2, x: 0, y: 1 },
    },
    md: {
      css: '0 4px 12px -2px rgb(15 23 42 / 0.06), 0 2px 4px -2px rgb(15 23 42 / 0.04)',
      ios: { color: 'rgba(15, 23, 42, 0.06)', radius: 12, x: 0, y: 4 },
    },
    lg: {
      css: '0 12px 32px -8px rgb(15 23 42 / 0.12), 0 4px 8px -4px rgb(15 23 42 / 0.06)',
      ios: { color: 'rgba(15, 23, 42, 0.12)', radius: 32, x: 0, y: 12 },
    },
    xl: {
      css: '0 24px 64px -12px rgb(15 23 42 / 0.18), 0 8px 16px -8px rgb(15 23 42 / 0.08)',
      ios: { color: 'rgba(15, 23, 42, 0.18)', radius: 64, x: 0, y: 24 },
    },
    ring: {
      css: '0 0 0 4px rgb(59 147 34 / 0.12)',
      ios: { color: 'rgba(59, 147, 34, 0.12)', radius: 4, x: 0, y: 0 },
    },
  },
} as const;

export type Tokens = typeof tokens;
export type ColorToken =
  | keyof Tokens['color']
  | `primary.${keyof Tokens['color']['primary']}`
  | `${'semantic' | 'status' | 'text'}.${string}`;
