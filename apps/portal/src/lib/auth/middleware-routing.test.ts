import { describe, expect, it } from 'vitest';
import { routeRequest, type MiddlewareSession } from './middleware-routing.js';

const healthy: MiddlewareSession = { mfaRequired: false };
const mfaPending: MiddlewareSession = { mfaRequired: true };
const dead: MiddlewareSession = { error: 'RefreshAccessTokenError', mfaRequired: false };

describe('routeRequest — dead session (RefreshAccessTokenError)', () => {
  it('renders /login in place and clears the cookie (does NOT bounce to /dashboard)', () => {
    // The regression: a dead session on /login used to fall through to the
    // "healthy session on /login → /dashboard" branch, and /dashboard
    // bounced back to /login → infinite "too many redirects".
    expect(routeRequest({ path: '/login', session: dead })).toEqual({
      kind: 'next',
      clearSession: true,
    });
  });

  it('redirects a protected path to /login with callbackUrl and clears the cookie', () => {
    expect(routeRequest({ path: '/orders', session: dead })).toEqual({
      kind: 'redirect',
      to: '/login',
      callbackUrl: '/orders',
      clearSession: true,
    });
  });

  it('clears the cookie even on /two-factor (no special-casing keeps the loop dead)', () => {
    expect(routeRequest({ path: '/two-factor', session: dead })).toEqual({
      kind: 'redirect',
      to: '/login',
      callbackUrl: '/two-factor',
      clearSession: true,
    });
  });
});

describe('routeRequest — healthy session', () => {
  it('bounces /login → /dashboard', () => {
    expect(routeRequest({ path: '/login', session: healthy })).toEqual({
      kind: 'redirect',
      to: '/dashboard',
    });
  });

  it('bounces /login → /two-factor when MFA is outstanding', () => {
    expect(routeRequest({ path: '/login', session: mfaPending })).toEqual({
      kind: 'redirect',
      to: '/two-factor',
    });
  });

  it('passes through a protected path', () => {
    expect(routeRequest({ path: '/orders', session: healthy })).toEqual({ kind: 'next' });
  });

  it('forces an MFA-pending session to /two-factor from a protected path', () => {
    expect(routeRequest({ path: '/orders', session: mfaPending })).toEqual({
      kind: 'redirect',
      to: '/two-factor',
    });
  });

  it('lets an MFA-pending session sit on /two-factor', () => {
    expect(routeRequest({ path: '/two-factor', session: mfaPending })).toEqual({ kind: 'next' });
  });
});

describe('routeRequest — no session', () => {
  it('redirects a protected path to /login with callbackUrl', () => {
    expect(routeRequest({ path: '/orders/abc', session: null })).toEqual({
      kind: 'redirect',
      to: '/login',
      callbackUrl: '/orders/abc',
    });
  });

  it('lets /login and /two-factor through', () => {
    expect(routeRequest({ path: '/login', session: null })).toEqual({ kind: 'next' });
    expect(routeRequest({ path: '/two-factor', session: null })).toEqual({ kind: 'next' });
  });

  it('never clears a cookie when there was no session', () => {
    const decision = routeRequest({ path: '/orders', session: null });
    expect('clearSession' in decision && decision.clearSession).toBeFalsy();
  });
});
