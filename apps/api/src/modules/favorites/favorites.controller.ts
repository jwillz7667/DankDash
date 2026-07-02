/**
 * `/v1/me/favorites` HTTP surface — consumer saved dispensaries + products.
 *
 *   GET    /v1/me/favorites                   — paginated reverse-chron feed.
 *   PUT    /v1/me/favorites/dispensaries/:id   — save a dispensary. 204.
 *   DELETE /v1/me/favorites/dispensaries/:id   — unsave. 204.
 *   PUT    /v1/me/favorites/products/:id       — save a product. 204.
 *   DELETE /v1/me/favorites/products/:id       — unsave. 204.
 *
 * PUT/DELETE are idempotent by design (the heart is a toggle, and a client may
 * retry) so both return 204 No Content regardless of prior state — the verb
 * already tells the client the resulting state. The write is scoped to
 * `req.user`, so there is no cross-user surface to probe.
 *
 * Guards: the global JwtAuthGuard populates `req.user`; RolesGuard narrows to
 * `customer` — favorites are a purely personal, consumer-app concept (vendor
 * and driver roles have no favorites surface). Rate limits are per-user: writes
 * are tight (a heart-tap is a single deliberate gesture) and the list is
 * generous because pull-to-refresh is routine.
 */
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { FavoritesQueryDto, type FavoritesResponse } from './dto/index.js';
import { FavoritesService } from './favorites.service.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

@Controller('me/favorites')
@UseGuards(RolesGuard)
@Roles('customer')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  @RateLimit({ name: 'favorites-list', tracker: 'user', limit: 120, windowMs: 60_000 })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FavoritesQueryDto,
  ): Promise<FavoritesResponse> {
    return this.favorites.list(user.userId, query);
  }

  @Put('dispensaries/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'favorites-add-dispensary', tracker: 'user', limit: 60, windowMs: 60_000 })
  addDispensary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.favorites.addDispensary(user.userId, id);
  }

  @Delete('dispensaries/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'favorites-remove-dispensary', tracker: 'user', limit: 60, windowMs: 60_000 })
  removeDispensary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.favorites.removeDispensary(user.userId, id);
  }

  @Put('products/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'favorites-add-product', tracker: 'user', limit: 60, windowMs: 60_000 })
  addProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.favorites.addProduct(user.userId, id);
  }

  @Delete('products/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ name: 'favorites-remove-product', tracker: 'user', limit: 60, windowMs: 60_000 })
  removeProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.favorites.removeProduct(user.userId, id);
  }
}
