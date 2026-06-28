/**
 * Server-side DankDash API client for checkout-web. Every call runs on the
 * server (RSC / Server Action) — the browser never holds the access token or
 * talks to the API. Each response is parsed with its zod schema at the
 * boundary so a contract drift fails loud here instead of corrupting a total.
 *
 * `fetchImpl` is injected (defaults to global `fetch`) so the request-building
 * and error-mapping logic is unit-testable without a live API.
 */
import {
  cartSchema,
  checkoutResponseSchema,
  complianceSchema,
  errorEnvelopeSchema,
  exchangeResponseSchema,
  type Cart,
  type CheckoutResult,
  type Compliance,
  type ExchangeResponse,
} from './api-schemas.js';
import { apiBaseUrl } from './env.js';
import { CheckoutError, type CheckoutErrorCode } from './errors.js';

export type FetchLike = typeof fetch;

export interface ApiClientOptions {
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
}

interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly token?: string;
  readonly body?: unknown;
}

function resolve(options: ApiClientOptions): { fetchImpl: FetchLike; baseUrl: string } {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    baseUrl: options.baseUrl ?? apiBaseUrl(),
  };
}

async function readEnvelope(res: Response): Promise<{ code: string; message: string } | null> {
  try {
    const parsed = errorEnvelopeSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

async function request(
  options: ApiClientOptions,
  req: RequestOptions,
  onError: { code: CheckoutErrorCode; userMessage: string },
): Promise<unknown> {
  const { fetchImpl, baseUrl } = resolve(options);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (req.token !== undefined) headers['authorization'] = `Bearer ${req.token}`;
  if (req.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${req.path}`, {
      method: req.method,
      headers,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      cache: 'no-store',
    });
  } catch (cause) {
    throw new CheckoutError(onError.code, `network error calling ${req.path}`, {
      userMessage: onError.userMessage,
      cause,
    });
  }

  if (!res.ok) {
    const envelope = await readEnvelope(res);
    throw new CheckoutError(
      onError.code,
      `${req.method} ${req.path} → ${String(res.status)}${
        envelope !== null ? ` (${envelope.code})` : ''
      }`,
      { userMessage: onError.userMessage, status: res.status },
    );
  }

  try {
    return await res.json();
  } catch (cause) {
    throw new CheckoutError('BAD_RESPONSE', `non-JSON response from ${req.path}`, {
      userMessage: 'We hit an unexpected error. Please try again.',
      cause,
    });
  }
}

function parseOr<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CheckoutError('BAD_RESPONSE', 'API response failed schema validation', {
      userMessage: 'We hit an unexpected error. Please try again.',
    });
  }
  return result.data;
}

/** Exchange a one-shot hand-off token for a checkout session. */
export async function exchangeHandoff(
  handoff: string,
  options: ApiClientOptions = {},
): Promise<ExchangeResponse> {
  const json = await request(
    options,
    { method: 'POST', path: '/v1/auth/checkout-handoff/exchange', body: { handoff } },
    {
      code: 'EXCHANGE_FAILED',
      userMessage:
        'This checkout link has expired or was already used. Return to the app and tap checkout again.',
    },
  );
  return parseOr(exchangeResponseSchema, json);
}

/** Read the cart for display. */
export async function getCart(
  cartId: string,
  token: string,
  options: ApiClientOptions = {},
): Promise<Cart> {
  const json = await request(
    options,
    { method: 'GET', path: `/v1/carts/${cartId}`, token },
    {
      code: 'CART_UNAVAILABLE',
      userMessage: 'Your cart could not be loaded. It may have expired.',
    },
  );
  return parseOr(cartSchema, json);
}

/** Run the server-authoritative compliance preview for the cart + address. */
export async function validateCart(
  cartId: string,
  deliveryAddressId: string,
  token: string,
  options: ApiClientOptions = {},
): Promise<Compliance> {
  const query = new URLSearchParams({ deliveryAddressId }).toString();
  const json = await request(
    options,
    { method: 'POST', path: `/v1/carts/${cartId}/validate?${query}`, token },
    {
      code: 'CART_UNAVAILABLE',
      userMessage: 'We could not verify your order against compliance rules.',
    },
  );
  return parseOr(complianceSchema, json);
}

export interface PlaceCheckoutInput {
  readonly deliveryAddressId: string;
  readonly driverTipCents: number;
  readonly deliveryInstructions?: string;
}

/** Place the order. The API re-runs compliance inside the same transaction. */
export async function placeCheckout(
  cartId: string,
  token: string,
  input: PlaceCheckoutInput,
  options: ApiClientOptions = {},
): Promise<CheckoutResult> {
  const body: Record<string, unknown> = {
    deliveryAddressId: input.deliveryAddressId,
    driverTipCents: input.driverTipCents,
  };
  if (input.deliveryInstructions !== undefined && input.deliveryInstructions.length > 0) {
    body['deliveryInstructions'] = input.deliveryInstructions;
  }
  const json = await request(
    options,
    { method: 'POST', path: `/v1/carts/${cartId}/checkout`, token, body },
    { code: 'CHECKOUT_FAILED', userMessage: 'We could not complete your order. Please try again.' },
  );
  return parseOr(checkoutResponseSchema, json);
}
