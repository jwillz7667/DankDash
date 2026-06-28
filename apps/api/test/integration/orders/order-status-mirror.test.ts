/**
 * Order-status drift guard.
 *
 * `packages/orders/src/states.ts` (ORDER_STATES), the `order_status` Postgres
 * enum in `@dankdash/db`, and the API `OrderStatusSchema` response DTO each
 * declare the order lifecycle states independently — the orders package is a
 * pure state machine that cannot import the DB or the API, the DB enum drives
 * a migration, and the DTO is the wire contract the iOS client mirrors.
 *
 * Nothing the compiler sees ties the three lists together, so a state added
 * to one and forgotten in another would ship silently: a DB row in a status
 * the API enum rejects 500s the response, and a machine state with no DB enum
 * member is unreachable. This test is the guard `states.ts` references — it
 * asserts the three declarations are the same set. It lives in apps/api
 * because this is the only place in the dependency graph that can import all
 * three.
 *
 * Pure comparison: no DB connection, no AppModule. The suite's globalSetup
 * still boots the shared containers, but this file touches neither.
 */
import { orderStatus } from '@dankdash/db';
import { ORDER_STATES } from '@dankdash/orders';
import { describe, expect, it } from 'vitest';
import { OrderStatusSchema } from '../../../src/modules/checkout/dto/index.js';

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('order_status mirror — ORDER_STATES vs DB enum vs OrderStatusSchema', () => {
  const machineStates = sorted(ORDER_STATES);
  const dbEnumStates = sorted(orderStatus.enumValues);
  const dtoStates = sorted(OrderStatusSchema.options);

  it('each declaration is internally free of duplicates', () => {
    expect(new Set(ORDER_STATES).size).toBe(ORDER_STATES.length);
    expect(new Set(orderStatus.enumValues).size).toBe(orderStatus.enumValues.length);
    expect(new Set(OrderStatusSchema.options).size).toBe(OrderStatusSchema.options.length);
  });

  it('@dankdash/orders ORDER_STATES matches the @dankdash/db order_status enum', () => {
    expect(machineStates).toEqual(dbEnumStates);
  });

  it('the API OrderStatusSchema matches the @dankdash/db order_status enum', () => {
    expect(dtoStates).toEqual(dbEnumStates);
  });

  it('all three declarations are the identical set of states', () => {
    expect(machineStates).toEqual(dtoStates);
  });
});
