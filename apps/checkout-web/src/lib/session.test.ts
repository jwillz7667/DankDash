import { describe, expect, it } from 'vitest';
import { parseSession, serializeSession, type CheckoutSession } from './session.js';

const SESSION: CheckoutSession = {
  accessToken: 'header.payload.sig',
  cartId: '00000000-0000-0000-0000-0000000000c1',
  deliveryAddressId: '00000000-0000-0000-0000-0000000000a1',
};

describe('session (de)serialization', () => {
  it('round-trips a valid session', () => {
    expect(parseSession(serializeSession(SESSION))).toEqual(SESSION);
  });

  it('returns null for an undefined or empty cookie', () => {
    expect(parseSession(undefined)).toBeNull();
    expect(parseSession('')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseSession('{not json')).toBeNull();
  });

  it('returns null when the payload fails the schema', () => {
    expect(parseSession(JSON.stringify({ accessToken: 'x' }))).toBeNull();
    expect(parseSession(JSON.stringify({ ...SESSION, cartId: 'not-a-uuid' }))).toBeNull();
  });
});
