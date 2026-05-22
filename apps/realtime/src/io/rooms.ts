/**
 * Room-name conventions — all writes to socket.io rooms go through these
 * helpers so the broadcast routing (streams/router.ts) and the join
 * handlers (namespaces/*.ts) cannot drift apart.
 *
 * The strings are public protocol: changing one is a breaking change for
 * any client that joins explicitly. As of Phase 9 the only explicit join
 * is the auto-join performed by the namespace handler — but the iOS
 * apps and the vendor portal both know these names, so treat them with
 * the care normally reserved for HTTP routes.
 */

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function dispensaryRoom(dispensaryId: string): string {
  return `dispensary:${dispensaryId}`;
}

export function driverRoom(driverId: string): string {
  return `driver:${driverId}`;
}
