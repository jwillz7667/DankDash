/**
 * Vitest setup — extends `expect` with @testing-library/jest-dom matchers
 * and registers a global `afterEach` cleanup so RTL's mounted components
 * are unmounted between tests (otherwise queries collide across the suite).
 */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
});
