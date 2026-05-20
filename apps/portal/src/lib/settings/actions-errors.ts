/**
 * Error types for the vendor-settings server actions. Same separation
 * as `lib/staff/actions-errors.ts` — Next.js 15 server-action files
 * (`'use server'`) restrict top-level exports to async functions, so
 * non-function exports live here.
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
