/**
 * @dankdash/utils public surface.
 *
 * Pure, dependency-light utilities shared across services. Anything
 * requiring DI, logging, or external IO does NOT belong here — put it
 * in the feature package that owns its lifecycle.
 */
export {
  CROCKFORD_ALPHABET,
  DEFAULT_MAX_ATTEMPTS,
  SHORT_CODE_LENGTH,
  ShortCodeCollisionError,
  generateShortCode,
  isValidShortCode,
  withCollisionRetry,
} from './short-code.js';
