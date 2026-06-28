/**
 * Vitest setup — extends `expect` with @testing-library/jest-dom matchers
 * and unmounts mounted components after each test so RTL queries don't
 * collide across the suite.
 */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
});
