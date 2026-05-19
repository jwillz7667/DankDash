// Re-export the shared Prettier config so editors and the prettier CLI
// pick it up at the repo root without needing per-package configs.
module.exports =
  require('./packages/config/prettier.config.js').default ??
  require('./packages/config/prettier.config.js');
