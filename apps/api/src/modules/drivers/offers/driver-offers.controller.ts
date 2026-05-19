/**
 * /v1/driver/offers — driver-self dispatch-offer HTTP surface.
 *
 *   POST /v1/driver/offers/:id/accept   — claim a still-open offer
 *   POST /v1/driver/offers/:id/decline  — pass with optional reason
 *
 * Auth: global JwtAuthGuard authenticates the principal;
 * DriverContextGuard (class-level) refuses non-driver principals and
 * attaches the `DriverContext` for `@CurrentDriver()`.
 *
 * Rate limits sized for human + retry behaviour: an offer is a single
 * tap that resolves once, so 30/min per user comfortably covers the
 * "tapped, network blip, retried" path while clamping a runaway client.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { CurrentDriver } from '../context/current-driver.decorator.js';
import { DriverContextGuard } from '../context/driver-context.guard.js';
import { DriverOffersService } from './driver-offers.service.js';
import { DeclineOfferRequestDto, type DispatchOfferResponse } from './dto/index.js';
import type { DriverContext } from '../context/driver-context.types.js';

@Controller('driver/offers')
@UseGuards(DriverContextGuard)
export class DriverOffersController {
  constructor(private readonly offers: DriverOffersService) {}

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'driver-offer-accept', tracker: 'user', limit: 30, windowMs: 60_000 })
  accept(
    @CurrentDriver() ctx: DriverContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DispatchOfferResponse> {
    return this.offers.accept(ctx, id);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'driver-offer-decline', tracker: 'user', limit: 60, windowMs: 60_000 })
  decline(
    @CurrentDriver() ctx: DriverContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DeclineOfferRequestDto,
  ): Promise<DispatchOfferResponse> {
    return this.offers.decline(ctx, id, body);
  }
}
