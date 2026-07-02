/**
 * Unit tests for FavoritesController.
 *
 * Guard composition (JwtAuthGuard global, RolesGuard→customer) is verified at
 * the module level. This suite proves the controller forwards the JWT
 * principal's `userId` plus the parsed query / path params verbatim to the
 * service, and returns the service's value unmodified.
 *
 *   - GET /                          → forwards (userId, query), returns response
 *   - PUT/DELETE dispensaries/:id     → forwards (userId, id), resolves void (204)
 *   - PUT/DELETE products/:id         → forwards (userId, id), resolves void (204)
 */
import { describe, expect, it } from 'vitest';
import { FavoritesController } from './favorites.controller.js';
import type { FavoritesService } from './favorites.service.js';
import type { FavoritesQueryDto, FavoritesResponse } from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const PRODUCT_ID = '01935f3d-0000-7000-8000-000000000020';

const PRINCIPAL: AuthenticatedUser = {
  userId: USER_ID,
  sessionId: '01935f3d-0000-7000-8000-000000000002',
  role: 'customer',
};

const RESPONSE: FavoritesResponse = {
  favorites: [],
  page: { limit: 24, offset: 0, total: 0 },
};

class FakeFavoritesService {
  public listCalls: { userId: string; query: FavoritesQueryDto }[] = [];
  public addDispensaryCalls: { userId: string; id: string }[] = [];
  public removeDispensaryCalls: { userId: string; id: string }[] = [];
  public addProductCalls: { userId: string; id: string }[] = [];
  public removeProductCalls: { userId: string; id: string }[] = [];

  list = (userId: string, query: FavoritesQueryDto): Promise<FavoritesResponse> => {
    this.listCalls.push({ userId, query });
    return Promise.resolve(RESPONSE);
  };
  addDispensary = (userId: string, id: string): Promise<void> => {
    this.addDispensaryCalls.push({ userId, id });
    return Promise.resolve();
  };
  removeDispensary = (userId: string, id: string): Promise<void> => {
    this.removeDispensaryCalls.push({ userId, id });
    return Promise.resolve();
  };
  addProduct = (userId: string, id: string): Promise<void> => {
    this.addProductCalls.push({ userId, id });
    return Promise.resolve();
  };
  removeProduct = (userId: string, id: string): Promise<void> => {
    this.removeProductCalls.push({ userId, id });
    return Promise.resolve();
  };
}

function makeController(): {
  controller: FavoritesController;
  service: FakeFavoritesService;
} {
  const service = new FakeFavoritesService();
  const controller = new FavoritesController(service as unknown as FavoritesService);
  return { controller, service };
}

describe('FavoritesController', () => {
  it('GET / forwards the principal userId and the parsed query', async () => {
    const { controller, service } = makeController();
    const query: FavoritesQueryDto = { limit: 10, offset: 20 };

    const result = await controller.list(PRINCIPAL, query);

    expect(result).toBe(RESPONSE);
    expect(service.listCalls).toEqual([{ userId: USER_ID, query }]);
  });

  it('PUT dispensaries/:id forwards (userId, id) and resolves void', async () => {
    const { controller, service } = makeController();

    const result = await controller.addDispensary(PRINCIPAL, DISPENSARY_ID);

    expect(result).toBeUndefined();
    expect(service.addDispensaryCalls).toEqual([{ userId: USER_ID, id: DISPENSARY_ID }]);
  });

  it('DELETE dispensaries/:id forwards (userId, id) and resolves void', async () => {
    const { controller, service } = makeController();

    const result = await controller.removeDispensary(PRINCIPAL, DISPENSARY_ID);

    expect(result).toBeUndefined();
    expect(service.removeDispensaryCalls).toEqual([{ userId: USER_ID, id: DISPENSARY_ID }]);
  });

  it('PUT products/:id forwards (userId, id) and resolves void', async () => {
    const { controller, service } = makeController();

    const result = await controller.addProduct(PRINCIPAL, PRODUCT_ID);

    expect(result).toBeUndefined();
    expect(service.addProductCalls).toEqual([{ userId: USER_ID, id: PRODUCT_ID }]);
  });

  it('DELETE products/:id forwards (userId, id) and resolves void', async () => {
    const { controller, service } = makeController();

    const result = await controller.removeProduct(PRINCIPAL, PRODUCT_ID);

    expect(result).toBeUndefined();
    expect(service.removeProductCalls).toEqual([{ userId: USER_ID, id: PRODUCT_ID }]);
  });
});
