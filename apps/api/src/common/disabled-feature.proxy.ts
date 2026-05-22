/**
 * Returns a Proxy that throws {@link FeatureDisabledError} on any
 * non-symbol property access. Used by feature modules to provide a
 * placeholder DI token when the feature's `ENABLE_*` flag is off: the
 * DI graph stays satisfied at module construction, no third-party
 * credentials are required, and any call that actually reaches the
 * proxy surfaces as a typed 503 instead of crashing the process.
 *
 * Symbol property access (`Symbol.toPrimitive`, `Symbol.iterator`, the
 * generic NestJS `instanceof` chain, ...) returns `undefined` so the
 * proxy doesn't break introspection or structured logging on the
 * surrounding object.
 */
import { FeatureDisabledError } from '@dankdash/types';

// The type parameter `T` is only used in the return type. That is the point
// of this utility — it lets callers specify the service type the proxy
// stands in for without an inline cast at every call site. eslint's
// "type-parameter used only once" rule is correct that T isn't in the
// parameter list; suppressed here because the pattern is intentional.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function createDisabledFeatureProxy<T extends object>(featureName: string): T {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      // `then` is accessed by promise-detection in await chains; returning
      // undefined keeps the value awaitable as a plain object instead of
      // tripping the proxy on routine framework introspection.
      if (prop === 'then') return undefined;
      throw new FeatureDisabledError(featureName, { invokedProperty: prop });
    },
  };
  return new Proxy({}, handler) as T;
}
