/**
 * Playwright sign-in helper.
 *
 * Drives the real login form against the in-process mock API (see
 * mock-stack.mjs) — Auth.js v5's credentials flow signs the encrypted
 * session cookie inside Next, so the only reliable way to obtain a
 * working cookie is to submit the form the same way the user would.
 *
 * The mock API accepts any non-empty `email` + `password` pair and
 * returns the `defaultUser` payload, so the credential values here are
 * arbitrary placeholders — they exist only to satisfy the form's
 * client-side Zod validation. A spec that wants to assert against a
 * specific user can POST to the admin surface before signing in.
 */
import { expect, type Page } from '@playwright/test';

export interface SignInOptions {
  readonly email?: string;
  readonly password?: string;
  /**
   * Path to land on after sign-in. Defaults to `/orders` (the queue
   * page that every Phase 14 spec exercises). The login form sets
   * `callbackUrl` from `searchParams`, so we navigate to
   * `/login?callbackUrl=...` to force the redirect.
   */
  readonly callbackUrl?: string;
}

const DEFAULT_EMAIL = 'manager@dankdash.test';
const DEFAULT_PASSWORD = 'playwright-only-not-a-real-password';

/**
 * Sign the page's browser context into the portal. Returns once the
 * `callbackUrl` page has rendered enough that subsequent assertions
 * can target it — specifically, we wait for the URL to leave `/login`
 * so a race between the form submit and the next navigation cannot
 * cause a spec to assert on the login page accidentally.
 */
export async function signIn(page: Page, options: SignInOptions = {}): Promise<void> {
  const email = options.email ?? DEFAULT_EMAIL;
  const password = options.password ?? DEFAULT_PASSWORD;
  const callbackUrl = options.callbackUrl ?? '/orders';

  await page.goto(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  // Form mounts via 'use client' — wait for the email input to be
  // interactive before typing into it.
  const emailInput = page.getByLabel('Email');
  await expect(emailInput).toBeVisible();
  await emailInput.fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /continue/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });
}

/**
 * POSTs JSON to the mock admin server. Specs reach for this to seed
 * orders, fire realtime events, force the WS into reject mode, etc.
 *
 * The admin port is read from `MOCK_ADMIN_PORT` (matches playwright.config.ts).
 */
export async function admin<TResponse = unknown>(path: string, body?: unknown): Promise<TResponse> {
  const port = process.env['MOCK_ADMIN_PORT'] ?? '4003';
  const url = `http://127.0.0.1:${port}${path}`;
  const init: RequestInit = {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`admin ${path} failed: ${String(response.status)} ${await response.text()}`);
  }
  return (await response.json()) as TResponse;
}

export interface VendorQueueOrderSummary {
  readonly id: string;
  readonly shortCode: string;
  readonly userId: string;
  readonly customerName: string | null;
  readonly status: string;
  readonly itemCount: number;
  readonly subtotalCents: number;
  readonly totalCents: number;
  readonly placedAt: string;
  readonly statusChangedAt: string;
  readonly acceptedAt: string | null;
  readonly preppingAt: string | null;
  readonly preparedAt: string | null;
}

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';
const CUSTOMER_ID = '01935f3d-0000-7000-8000-00000000aaaa';

/**
 * Builds a minimal but wire-shape-correct `VendorQueueOrderSummary` for
 * tests. Defaults: `placed` status, 1 item, customer "Alex Tester",
 * placed 30s ago. Override anything that matters to the assertion.
 */
export function fixtureQueueOrder(
  overrides: Partial<VendorQueueOrderSummary> = {},
): VendorQueueOrderSummary {
  const now = new Date();
  const thirtySecondsAgo = new Date(now.getTime() - 30_000).toISOString();
  return {
    id: overrides.id ?? '01935f3d-0000-7000-8000-000000000001',
    shortCode: overrides.shortCode ?? 'AAAA',
    userId: overrides.userId ?? CUSTOMER_ID,
    customerName: overrides.customerName ?? 'Alex Tester',
    status: overrides.status ?? 'placed',
    itemCount: overrides.itemCount ?? 1,
    subtotalCents: overrides.subtotalCents ?? 5400,
    totalCents: overrides.totalCents ?? 6210,
    placedAt: overrides.placedAt ?? thirtySecondsAgo,
    statusChangedAt: overrides.statusChangedAt ?? thirtySecondsAgo,
    acceptedAt: overrides.acceptedAt ?? null,
    preppingAt: overrides.preppingAt ?? null,
    preparedAt: overrides.preparedAt ?? null,
  };
}

export interface RealtimeOrderCreatedPayload {
  readonly orderId: string;
  readonly customerId: string;
  readonly dispensaryId: string;
  readonly shortCode: string;
  readonly totalCents: number;
  readonly status: string;
  readonly placedAt: string;
}

/**
 * `order:created` event payload (mirrors `OrderSummary` in
 * `lib/realtime/client.ts`). Distinct from `fixtureQueueOrder` —
 * realtime payloads are slimmer than the queue projection.
 */
export function fixtureCreatedEvent(
  overrides: Partial<RealtimeOrderCreatedPayload> = {},
): RealtimeOrderCreatedPayload {
  return {
    orderId: overrides.orderId ?? '01935f3d-0000-7000-8000-000000000002',
    customerId: overrides.customerId ?? CUSTOMER_ID,
    dispensaryId: overrides.dispensaryId ?? DISPENSARY_ID,
    shortCode: overrides.shortCode ?? 'BBBB',
    totalCents: overrides.totalCents ?? 4800,
    status: overrides.status ?? 'placed',
    placedAt: overrides.placedAt ?? new Date().toISOString(),
  };
}
