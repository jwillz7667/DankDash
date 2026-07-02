import { describe, expect, it } from 'vitest';
import { type PayoutStatus } from '../schema/enums.js';
import { resolvePayoutTerminalTransition } from './payout-settlement.js';

describe('resolvePayoutTerminalTransition', () => {
  it('applies when the row is still processing (→ completed)', () => {
    expect(resolvePayoutTerminalTransition('processing', 'completed')).toEqual({ kind: 'apply' });
  });

  it('applies when the row is still processing (→ failed)', () => {
    expect(resolvePayoutTerminalTransition('processing', 'failed')).toEqual({ kind: 'apply' });
  });

  it('is a replay when the row already holds the target terminal state', () => {
    expect(resolvePayoutTerminalTransition('completed', 'completed')).toEqual({ kind: 'replay' });
    expect(resolvePayoutTerminalTransition('failed', 'failed')).toEqual({ kind: 'replay' });
  });

  it('is a conflict when a late paid event contradicts a failed row', () => {
    expect(resolvePayoutTerminalTransition('failed', 'completed')).toEqual({ kind: 'conflict' });
  });

  it('is a conflict when a late failed event contradicts a completed row', () => {
    expect(resolvePayoutTerminalTransition('completed', 'failed')).toEqual({ kind: 'conflict' });
  });

  it('treats pre-dispatch states as conflicts — they are never advanced blindly', () => {
    const preDispatch: readonly PayoutStatus[] = ['pending', 'canceled'];
    for (const status of preDispatch) {
      expect(resolvePayoutTerminalTransition(status, 'completed')).toEqual({ kind: 'conflict' });
      expect(resolvePayoutTerminalTransition(status, 'failed')).toEqual({ kind: 'conflict' });
    }
  });
});
