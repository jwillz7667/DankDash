/**
 * Local error type for checkout-web. The shared workspace lint rule bans
 * `throw new Error(...)` in favour of a named domain error; this is the
 * Next-app-flavoured equivalent (a plain Error subclass, no NestJS HTTP
 * coupling). `code` is a stable machine string; `userMessage` is safe to
 * render to the customer.
 */
export type CheckoutErrorCode =
  | 'CONFIG'
  | 'EXCHANGE_FAILED'
  | 'SESSION_MISSING'
  | 'CART_UNAVAILABLE'
  | 'COMPLIANCE_BLOCKED'
  | 'CHECKOUT_FAILED'
  | 'BAD_RESPONSE';

export class CheckoutError extends Error {
  public readonly code: CheckoutErrorCode;
  public readonly userMessage: string;
  public readonly status: number | undefined;

  constructor(
    code: CheckoutErrorCode,
    message: string,
    options: { userMessage?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CheckoutError';
    this.code = code;
    this.userMessage = options.userMessage ?? message;
    this.status = options.status;
  }
}
