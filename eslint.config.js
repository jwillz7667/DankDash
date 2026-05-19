// Repo-root ESLint flat config — re-exports the shared config from
// @dankdash/config so the `eslint` CLI works from any cwd.
import sharedConfig from './packages/config/eslint.config.js';

export default sharedConfig;
