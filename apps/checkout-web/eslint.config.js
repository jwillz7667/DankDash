// @ts-check
/**
 * checkout-web ESLint config — extends the shared workspace rules (no-console,
 * type-aware safety, import order, no DomainError-less throws) and layers the
 * Next-app relaxations on top, mirroring apps/portal.
 */
import sharedConfig from '../../packages/config/eslint.config.js';

export default [
  ...sharedConfig,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['next.config.mjs', 'vitest.config.ts', 'vitest.setup.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: ['.next/**', 'next-env.d.ts', 'coverage/**'],
  },
];
