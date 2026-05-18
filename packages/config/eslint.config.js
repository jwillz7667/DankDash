// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Shared ESLint flat config for the DankDash monorepo.
 *
 * Per-package eslint.config.js files import this and may layer on
 * package-specific overrides. Do NOT loosen rules in package configs;
 * if a rule is wrong, fix it here so every package gets the change.
 *
 * Layout of the config blocks below (order matters):
 *   1. global ignores
 *   2. eslint:recommended + typescript-eslint strict+stylistic for TS files
 *   3. plain-JS block (eslint.config.js, prettier.config.js, scripts/*.js)
 *      with type-aware rules disabled — these files are not part of any TS
 *      project and would otherwise blow up the project service.
 *   4. test-file overrides
 *   5. config/script overrides
 *   6. prettier — must be last so it strips any conflicting style rules.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.generated.ts',
    ],
  },
  // Type-aware rules for TypeScript source.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
      parserOptions: {
        projectService: {
          allowDefaultProject: [],
        },
        tsconfigRootDir: process.cwd(),
      },
    },
    plugins: {
      import: importPlugin,
      'unused-imports': unusedImports,
    },
    rules: {
      // PII / production logging discipline — see CLAUDE.md and PHASES 0.8.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // Async correctness.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/only-throw-error': 'error',

      // Type discipline — the rule "no `any` in TS" from the non-negotiables.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // Style — accept both `readonly T[]` and `ReadonlyArray<T>`. The former is
      // shorter; the latter reads better in complex generic positions. Authors
      // choose; we do not nitpick.
      '@typescript-eslint/array-type': 'off',

      // Allow bracket access for `process.env.X` style — the strict TS rule
      // for index signatures already pushes authors toward dot notation where
      // it is safe; we don't need a second linter complaining.
      '@typescript-eslint/dot-notation': 'off',

      // Type-only imports kept as type imports.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // No silent catches.
      '@typescript-eslint/no-unused-vars': 'off', // delegated to unused-imports
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Imports.
      'import/no-duplicates': 'error',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'never',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      // Style — let prettier own formatting; flag substance.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'multi-line'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "ThrowStatement[argument.type='NewExpression'][argument.callee.name='Error']",
          message:
            'Use a DomainError subclass from @dankdash/types instead of `throw new Error(...)`.',
        },
      ],
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
        node: true,
      },
    },
  },
  // Plain JS files — eslint.config.js, prettier.config.js, root scripts.
  // These are not part of any TS project; disable type-aware rules so the
  // typescript-eslint project service does not try to resolve them.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      'no-console': 'off',
    },
  },
  // Test files relax a few rules.
  {
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-console': 'off',
    },
  },
  // Config files in TS (vitest.config.ts, drizzle.config.ts) — relax type
  // discipline; they often need to construct loose options objects.
  {
    files: ['**/*.config.{ts,mts,cts}', '**/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);
