/**
 * Redaction tests for createLogger.
 *
 * Asserts the production-mode JSON logger censors Restricted/credential
 * values at the depths they realistically appear: at the root, one level
 * deep (`user.dob`), and two levels deep — the `err.details.<key>` shape the
 * GlobalExceptionFilter logs when a DomainError carries a context bag, and
 * nested compliance contexts (`context.user.dateOfBirth`). pino's `*`
 * wildcard only matches one segment, so depth coverage is the crux of the
 * fix. Non-sensitive fields must still pass through untouched.
 */
import { type DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

const CENSOR = '[REDACTED]';

function capture(): { destination: DestinationStream; lines: () => Record<string, unknown>[] } {
  const raw: string[] = [];
  return {
    destination: {
      write(chunk: string): void {
        raw.push(chunk);
      },
    },
    lines: () =>
      raw
        .join('')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function logOne(payload: Record<string, unknown>): Record<string, unknown> {
  const sink = capture();
  const logger = createLogger({
    name: 'test',
    environment: 'production',
    destination: sink.destination,
  });
  logger.info(payload, 'msg');
  const [line] = sink.lines();
  if (line === undefined) throw new Error('no log line captured');
  return line;
}

describe('createLogger redaction', () => {
  it('censors a Restricted value at the root', () => {
    const line = logOne({ dob: '1990-01-15', documentNumber: 'D123', mfaSecret: 's3cr3t' });
    expect(line['dob']).toBe(CENSOR);
    expect(line['documentNumber']).toBe(CENSOR);
    expect(line['mfaSecret']).toBe(CENSOR);
  });

  it('censors a Restricted value one level deep (user.dateOfBirth)', () => {
    const line = logOne({ user: { id: 'u1', dateOfBirth: '1990-01-15' } });
    const user = line['user'] as Record<string, unknown>;
    expect(user['dateOfBirth']).toBe(CENSOR);
    expect(user['id']).toBe('u1'); // non-sensitive passes through
  });

  it('censors two levels deep, covering the err.details.<key> exception shape', () => {
    const line = logOne({ err: { message: 'boom', details: { dateOfBirth: '1990-01-15' } } });
    const err = line['err'] as Record<string, unknown>;
    const details = err['details'] as Record<string, unknown>;
    expect(details['dateOfBirth']).toBe(CENSOR);
    expect(err['message']).toBe('boom');
  });

  it('censors the nested compliance context shape (context.user.dob)', () => {
    const line = logOne({ context: { user: { dob: '1990-01-15', region: 'MN' } } });
    const ctxUser = (line['context'] as Record<string, unknown>)['user'] as Record<string, unknown>;
    expect(ctxUser['dob']).toBe(CENSOR);
    expect(ctxUser['region']).toBe('MN');
  });

  it('censors the document_dob_value column and snake/camel variants at depth', () => {
    const line = logOne({
      row: {
        document_dob_value: '1990-01-15',
        license_number_hash: 'abc',
        mfa_secret_enc: 'enc',
        bank_name: 'First Bank',
      },
    });
    const row = line['row'] as Record<string, unknown>;
    expect(row['document_dob_value']).toBe(CENSOR);
    expect(row['license_number_hash']).toBe(CENSOR);
    expect(row['mfa_secret_enc']).toBe(CENSOR);
    expect(row['bank_name']).toBe(CENSOR);
  });

  it('redacts authorization and cookie request headers', () => {
    const line = logOne({ req: { headers: { authorization: 'Bearer x', cookie: 'sid=1' } } });
    const headers = (line['req'] as Record<string, unknown>)['headers'] as Record<string, unknown>;
    expect(headers['authorization']).toBe(CENSOR);
    expect(headers['cookie']).toBe(CENSOR);
  });

  it('leaves non-sensitive fields untouched', () => {
    const line = logOne({ orderId: 'o1', status: 'delivered', latency_ms: 42 });
    expect(line['orderId']).toBe('o1');
    expect(line['status']).toBe('delivered');
    expect(line['latency_ms']).toBe(42);
  });

  it('constructs without throwing on the full multi-depth wildcard path set', () => {
    // fast-redact rejects some path combinations at construction; this guards
    // against a future leaf-key/prefix addition that would crash the logger.
    expect(() => createLogger({ name: 'ctor', environment: 'production' })).not.toThrow();
  });
});
