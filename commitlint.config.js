/**
 * Conventional Commits enforcement for DankDash.
 *
 * Subject ≤72 chars, imperative mood, no trailing period. Allowed scopes are
 * the top-level apps/packages — extend the list when a new workspace lands.
 * Special scopes:
 *   - `release`  : version bumps and changelog commits cut by CI.
 *   - `repo`     : changes that touch only root-level files (CI, configs).
 *   - `docs`     : changes scoped to docs/ (ADRs, runbooks, specs).
 */

/** @type {import('@commitlint/types').UserConfig} */
const config = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
    'scope-enum': [
      2,
      'always',
      [
        'api',
        'realtime',
        'workers',
        'portal',
        'checkout-web',
        'ios-consumer',
        'ios-driver',
        'db',
        'compliance',
        'config',
        'types',
        'ui',
        'test-utils',
        'infra',
        'docs',
        'release',
        'repo',
      ],
    ],
    'scope-empty': [1, 'never'],
    'subject-case': [2, 'never', ['upper-case', 'pascal-case', 'start-case']],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 72],
    'body-leading-blank': [2, 'always'],
    'footer-leading-blank': [2, 'always'],
  },
};

export default config;
