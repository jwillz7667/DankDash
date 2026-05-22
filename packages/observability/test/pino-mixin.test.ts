/**
 * Pino mixin — verifies the context fields land on actual log records.
 *
 * Using a real pino instance rather than mocking the mixin call lets
 * the test catch the case where the mixin output shape diverges from
 * what pino actually merges (e.g. returning `null` instead of `{}`
 * inside a nested object on older pino versions).
 */
import { Writable } from 'node:stream';
import { pino, type Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '../src/context/als.js';
import { requestContextMixin } from '../src/logging/pino-mixin.js';

interface CapturedLog {
  readonly request_id?: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly user_id?: string;
  readonly dispensary_id?: string;
  readonly msg?: string;
  readonly level?: number;
}

function buildCapturingLogger(): { logger: Logger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      entries.push(JSON.parse(chunk.toString('utf-8')) as CapturedLog);
      cb();
    },
  });
  const logger = pino({ mixin: requestContextMixin }, stream);
  return { logger, entries };
}

describe('requestContextMixin', () => {
  it('adds no context fields when ALS has no active store', () => {
    const { logger, entries } = buildCapturingLogger();
    logger.info('no-context');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.request_id).toBeUndefined();
    expect(entries[0]?.user_id).toBeUndefined();
    expect(entries[0]?.msg).toBe('no-context');
  });

  it('adds request_id when ALS has a basic context', () => {
    const { logger, entries } = buildCapturingLogger();
    runWithRequestContext({ requestId: 'rid-1' }, () => {
      logger.info('hello');
    });
    expect(entries[0]?.request_id).toBe('rid-1');
    expect(entries[0]?.user_id).toBeUndefined();
  });

  it('adds all populated context fields and skips undefined ones', () => {
    const { logger, entries } = buildCapturingLogger();
    runWithRequestContext(
      {
        requestId: 'rid-2',
        traceId: 't-1',
        spanId: 's-1',
        userId: 'u-1',
        dispensaryId: 'd-1',
      },
      () => {
        logger.info('hello');
      },
    );
    expect(entries[0]).toMatchObject({
      request_id: 'rid-2',
      trace_id: 't-1',
      span_id: 's-1',
      user_id: 'u-1',
      dispensary_id: 'd-1',
    });
  });

  it('keeps fields stable across multiple log calls inside the same boundary', () => {
    const { logger, entries } = buildCapturingLogger();
    runWithRequestContext({ requestId: 'rid-3', userId: 'u-9' }, () => {
      logger.info('one');
      logger.warn('two');
      logger.error('three');
    });
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.request_id).toBe('rid-3');
      expect(entry.user_id).toBe('u-9');
    }
  });
});
