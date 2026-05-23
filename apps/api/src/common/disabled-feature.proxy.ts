/**
 * Returns a Proxy that throws {@link FeatureDisabledError} on any
 * property access that looks like a real method invocation. Used by
 * feature modules to provide a placeholder DI token when the feature's
 * `ENABLE_*` flag is off: the DI graph stays satisfied at module
 * construction, no third-party credentials are required, and any call
 * that actually reaches the proxy surfaces as a typed 503 instead of
 * crashing the process.
 *
 * Framework introspection paths must NOT throw — Nest, the event
 * emitter, the metadata scanner, and the await machinery all probe
 * provider instances for the presence of well-known hook names and
 * for inherited `Object.prototype` methods. Throwing during those
 * probes crashes app bootstrap. Three categories of property access
 * are silently passed through as `undefined`:
 *
 *   1. Symbol properties (`Symbol.toPrimitive`, `Symbol.iterator`,
 *      Nest's `instanceof` chain).
 *   2. NestJS lifecycle hooks + the promise-detection `then` probe
 *      (`PASSTHROUGH_PROPERTIES` below).
 *   3. Anything inherited from `Object.prototype` — `__defineGetter__`,
 *      `constructor`, `hasOwnProperty`, `toString`, … — which the
 *      `@nestjs/event-emitter` `EventSubscribersLoader` enumerates via
 *      `Object.getOwnPropertyNames(Object.prototype)` on every provider
 *      to discover decorated event listeners.
 *
 * Real method invocations still surface as a typed 503.
 */
import { FeatureDisabledError } from '@dankdash/types';

/**
 * Property names that framework code probes via `typeof obj.hook === 'function'`
 * to decide whether to invoke a hook. These MUST resolve to `undefined`
 * rather than throwing — otherwise the proxy crashes Nest at bootstrap.
 *
 *   - `then`: promise detection in await chains
 *   - `onModuleInit`, `onApplicationBootstrap`,
 *     `onModuleDestroy`, `beforeApplicationShutdown`,
 *     `onApplicationShutdown`: the full NestJS lifecycle-hook set
 */
const PASSTHROUGH_PROPERTIES = new Set<string>([
  'then',
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

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
      if (PASSTHROUGH_PROPERTIES.has(prop)) return undefined;
      if (Reflect.has(Object.prototype, prop)) return undefined;
      throw new FeatureDisabledError(featureName, { invokedProperty: prop });
    },
  };
  return new Proxy({}, handler) as T;
}
