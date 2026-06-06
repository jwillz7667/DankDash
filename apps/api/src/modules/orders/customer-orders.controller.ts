/**
 * /v1/orders — customer-side orders surface.
 *
 *   GET    /v1/orders                  paginated, scoped to the JWT user
 *   GET    /v1/orders/:id              single, scoped to the JWT user
 *   POST   /v1/orders/:id/cancel       customer cancel (pre-acceptance only)
 *   POST   /v1/orders/:id/rate         post-delivery rating
 *
 * Cancel is the only consumer-side state transition; everything past
 * `accepted` is the dispensary or driver's decision. The state machine
 * enforces the "pre-acceptance only" rule (CUSTOMER_CANCEL has a
 * transition only out of `placed`), so we don't repeat the check here —
 * a CUSTOMER_CANCEL on an `accepted` order surfaces as 422
 * ORDER_INVALID_TRANSITION which the iOS client renders as
 * "It's too late to cancel — your order has been accepted by the
 * dispensary".
 *
 * Roles allow-list intentionally excludes vendor / driver staff; an
 * `admin` is allowed for support tooling so an operator can cancel a
 * stuck order on a customer's behalf.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { type OrderResponse } from '../checkout/dto/index.js';
import { type CustomerOrderDetailResponse } from './dto/customer-order-detail.dto.js';
import {
  CancelOrderRequestDto,
  ListOrdersQueryDto,
  RateOrderRequestDto,
  type ListOrdersResponse,
  type TransitionResponse,
} from './dto/index.js';
import { OrderTransitionService } from './order-transition.service.js';
import { projectOrder } from './order.projection.js';
import { OrdersService } from './orders.service.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller('orders')
@UseGuards(RolesGuard)
@Roles('customer', 'admin', 'superadmin')
export class CustomerOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly transitions: OrderTransitionService,
  ) {}

  @Get()
  @RateLimit({ name: 'orders-list', tracker: 'user', limit: 120, windowMs: 60_000 })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrdersQueryDto,
  ): Promise<ListOrdersResponse> {
    const rows = await this.orders.listForUser(user.userId, query.limit);
    return { orders: rows.map(projectOrder) };
  }

  @Get(':id')
  @RateLimit({ name: 'orders-get', tracker: 'user', limit: 240, windowMs: 60_000 })
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerOrderDetailResponse> {
    return this.orders.getDetailForUser(user.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'orders-cancel', tracker: 'user', limit: 30, windowMs: 60_000 })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CancelOrderRequestDto,
  ): Promise<TransitionResponse> {
    // Pre-check ownership so a forged orderId returns 404 not 422 — the
    // state machine would happily refuse the transition regardless, but
    // 404 is the truer answer for "you have no claim on this order".
    await this.orders.findForUser(user.userId, id);

    const result = await this.transitions.transition({
      orderId: id,
      event: 'CUSTOMER_CANCEL',
      actor: { userId: user.userId, role: 'customer' },
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      patch: {
        canceledBy: user.userId,
        ...(body.reason !== undefined ? { cancelReason: body.reason } : {}),
      },
    });

    return {
      id: result.orderId,
      status: result.toStatus,
      statusChangedAt: new Date().toISOString(),
    };
  }

  @Post(':id/rate')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'orders-rate', tracker: 'user', limit: 30, windowMs: 60_000 })
  async rate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RateOrderRequestDto,
  ): Promise<OrderResponse> {
    return this.orders.rateForUser(user.userId, id, body);
  }
}
