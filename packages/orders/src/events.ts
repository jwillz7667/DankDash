/**
 * The vocabulary of state-machine events. Every transition diagram edge has
 * exactly one event type; the type's name encodes the actor expected to send
 * it (CUSTOMER_, VENDOR_, DRIVER_, SYSTEM_-prefixed-by-context) so that the
 * service-layer authorization check stays in sync with the diagram.
 *
 * Authorization is enforced in `OrderTransitionService`, not the state
 * machine — the machine answers "is this transition legal?" while the
 * service answers "is *this caller* allowed to request it?".
 */
export type OrderEventType =
  | 'PAYMENT_FAILED'
  | 'CUSTOMER_CANCEL'
  | 'VENDOR_ACCEPT'
  | 'VENDOR_REJECT'
  | 'VENDOR_PREPPING'
  | 'VENDOR_READY'
  | 'STORE_CANCEL'
  | 'DISPATCH_QUEUE'
  | 'DISPATCH_FAILED'
  | 'DRIVER_ASSIGNED'
  | 'DRIVER_EN_ROUTE_PICKUP'
  | 'DRIVER_PICKED_UP'
  | 'DRIVER_EN_ROUTE_DROPOFF'
  | 'DRIVER_ARRIVED'
  | 'DRIVER_ID_SCAN_STARTED'
  | 'ID_SCAN_PASSED'
  | 'ID_SCAN_FAILED'
  | 'DRIVER_DELIVERED'
  | 'DRIVER_ID_SCAN_RETRY'
  | 'DRIVER_RETURNED'
  | 'DISPUTE_OPENED';

/**
 * Discriminated union of every event accepted by the order machine. The
 * machine itself takes no payload — payloads (cancel reason, scan ref, etc.)
 * are written to the `order_events.payload` JSON column by the service
 * layer in the same transaction as the status update, and are not part of
 * the state transition vocabulary.
 */
export interface OrderMachineEvent {
  readonly type: OrderEventType;
}
