/**
 * Error types for the vendor-orders server actions. Co-located with
 * `actions.ts` would be cleaner, but Next.js 15 server-action files
 * (`'use server'`) restrict top-level exports to async functions —
 * exporting a class from that file is a build error.
 */

export class NoDispensaryContextError extends Error {
  public readonly code = 'NO_DISPENSARY_CONTEXT' as const;

  constructor() {
    super('No active dispensary on the current session.');
    this.name = 'NoDispensaryContextError';
  }
}

export function isNoDispensaryContextError(error: unknown): error is NoDispensaryContextError {
  return error instanceof NoDispensaryContextError;
}
