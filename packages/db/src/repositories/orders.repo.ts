import { RepositoryError } from '@dankdash/types';
import { and, desc, eq } from 'drizzle-orm';
import { type OrderStatus } from '../schema/enums.js';
import {
  orderEvents,
  orderItems,
  orders,
  type NewOrder,
  type NewOrderEvent,
  type NewOrderItem,
  type Order,
  type OrderEvent,
  type OrderItem,
} from '../schema/orders.js';
import { BaseRepository, newId } from './base.js';

/**
 * Inputs for an order-status transition. The service layer constructs this
 * after validating the transition against the XState machine; the repository
 * simply persists the change atomically alongside an immutable event row.
 */
export interface OrderStatusTransitionInput {
  readonly orderId: string;
  readonly toStatus: OrderStatus;
  readonly eventType: string;
  readonly actorUserId?: string;
  readonly actorRole?: string;
  readonly payload?: Record<string, unknown>;
  /**
   * Optional patch applied to the order row in the same UPDATE. Used to set
   * the per-status timestamp (e.g. `acceptedAt`, `pickedUpAt`) or fields like
   * `canceledBy`, `cancelReason` without a second round trip.
   */
  readonly patch?: Partial<Omit<NewOrder, 'id' | 'createdAt' | 'updatedAt' | 'status'>>;
}

export class OrdersRepository extends BaseRepository {
  async findById(id: string): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(eq(orders.id, id)).limit(1);
    return row ?? null;
  }

  async findByShortCode(shortCode: string): Promise<Order | null> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.shortCode, shortCode))
      .limit(1);
    return row ?? null;
  }

  async listForUser(userId: string, limit = 50): Promise<readonly Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.placedAt))
      .limit(limit);
  }

  async listForDispensary(
    dispensaryId: string,
    status?: OrderStatus,
    limit = 100,
  ): Promise<readonly Order[]> {
    const where =
      status === undefined
        ? eq(orders.dispensaryId, dispensaryId)
        : and(eq(orders.dispensaryId, dispensaryId), eq(orders.status, status));
    return this.db.select().from(orders).where(where).orderBy(desc(orders.placedAt)).limit(limit);
  }

  async listForDriver(driverId: string, limit = 100): Promise<readonly Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(eq(orders.driverId, driverId))
      .orderBy(desc(orders.placedAt))
      .limit(limit);
  }

  async create(input: Omit<NewOrder, 'id'> & { readonly id?: string }): Promise<Order> {
    const [row] = await this.db
      .insert(orders)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('orders insert returned no row');
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<NewOrder, 'id' | 'createdAt'>>,
  ): Promise<Order | null> {
    const [row] = await this.db
      .update(orders)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(orders.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Atomic status transition. Updates `orders.status`, `status_changed_at`,
   * and any supplied per-status timestamps in the SAME transaction that
   * appends the immutable `order_events` row. Either both writes succeed
   * or neither — the audit trail can never disagree with current state.
   */
  async transitionStatus(input: OrderStatusTransitionInput): Promise<Order> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [updated] = await tx
        .update(orders)
        .set({
          ...input.patch,
          status: input.toStatus,
          statusChangedAt: now,
          updatedAt: now,
        })
        .where(eq(orders.id, input.orderId))
        .returning();
      if (updated === undefined) {
        throw new RepositoryError(`orders.transitionStatus: order ${input.orderId} not found`);
      }
      await tx.insert(orderEvents).values({
        id: newId(),
        orderId: input.orderId,
        eventType: input.eventType,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        payload: input.payload ?? {},
        occurredAt: now,
      } satisfies NewOrderEvent);
      return updated;
    });
  }

  async recordRating(
    id: string,
    ratings: Pick<
      NewOrder,
      'customerRating' | 'customerReview' | 'dispensaryRating' | 'driverRating'
    >,
  ): Promise<Order | null> {
    return this.update(id, ratings);
  }
}

export class OrderItemsRepository extends BaseRepository {
  async listForOrder(orderId: string): Promise<readonly OrderItem[]> {
    return this.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  }

  async create(input: Omit<NewOrderItem, 'id'> & { readonly id?: string }): Promise<OrderItem> {
    const [row] = await this.db
      .insert(orderItems)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('order_items insert returned no row');
    return row;
  }

  async createMany(
    inputs: readonly (Omit<NewOrderItem, 'id'> & { readonly id?: string })[],
  ): Promise<readonly OrderItem[]> {
    if (inputs.length === 0) return [];
    const values = inputs.map((input) => ({ ...input, id: input.id ?? newId() }));
    return this.db.insert(orderItems).values(values).returning();
  }
}

/**
 * Append-only repository — the underlying `order_events` table is guarded by
 * a BEFORE UPDATE OR DELETE trigger (`dankdash_block_mutation`) that rejects
 * mutations regardless of role. No `update` or `delete` methods are exposed.
 */
export class OrderEventsRepository extends BaseRepository {
  async record(input: Omit<NewOrderEvent, 'id'> & { readonly id?: string }): Promise<OrderEvent> {
    const [row] = await this.db
      .insert(orderEvents)
      .values({ ...input, id: input.id ?? newId() })
      .returning();
    if (row === undefined) throw new RepositoryError('order_events insert returned no row');
    return row;
  }

  async listForOrder(orderId: string, limit = 200): Promise<readonly OrderEvent[]> {
    return this.db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, orderId))
      .orderBy(desc(orderEvents.occurredAt))
      .limit(limit);
  }
}
