# @dankdash/checkout-web

Consumer checkout web — Next.js 15 (App Router). Apple App Store guideline
1.4.3 / 5.1.1 prohibits completing a cannabis purchase inside the iOS app, so
the consumer app browses only and opens a Safari view at
`app.dankdash.com/checkout?handoff=<token>`, served by this package, to take
payment. See `docs/spec/DankDash-Technical-Spec.md` §10.4.

## Flow

1. **`/checkout?handoff=<jwt>`** — the fixed URL the iOS app opens. The
   single-shot hand-off token is staged into a Server Action
   (`startCheckout`) which calls `POST /v1/auth/checkout-handoff/exchange` to
   trade it for a short-lived access-token session, stores that session in an
   **httpOnly** cookie (the token never reaches client JS), and redirects to
   review. The exchange is idempotent on the session cookie so a reload or a
   double-submit never re-consumes the one-shot token.
2. **`/checkout/review`** — server-fetches the cart (`GET /v1/carts/:id`) and
   the server-authoritative compliance preview
   (`POST /v1/carts/:id/validate`), renders the order summary + the MN
   statutory compliance bars, and collects the (mandatory, $2-floor) driver
   tip and delivery note. Submitting runs the `placeOrder` Server Action →
   `POST /v1/carts/:id/checkout` (the API re-runs compliance inside the order
   transaction). A blocked compliance result hides the pay button.
3. **`/checkout/confirmation`** — shows the order code + total and a
   `dankdash://order/complete?orderId=…` deep link back into the iOS app,
   which its OrderTracking flow is waiting on.
4. **`/checkout/error`** — typed end states (expired link, session timeout,
   cart unavailable, compliance-blocked).

All API calls run server-side (RSC + Server Actions); the browser never holds
the access token or talks to the DankDash API directly.

## Configuration

- `CHECKOUT_API_BASE_URL` (or `INTERNAL_API_BASE_URL`) — base URL of the
  DankDash API. Required in production; defaults to `http://localhost:3000`
  in development.

## Commands

```bash
pnpm --filter @dankdash/checkout-web dev        # next dev on :3002
pnpm --filter @dankdash/checkout-web build      # production build
pnpm --filter @dankdash/checkout-web typecheck
pnpm --filter @dankdash/checkout-web lint
pnpm --filter @dankdash/checkout-web test       # vitest (lib + components)
```
