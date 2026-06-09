/**
 * Unit tests for AddressesController.
 *
 * Guard composition (JwtAuthGuard global, RolesGuard) is verified at the
 * module level. This suite proves the controller forwards the JWT
 * principal's `userId` and the parsed body / path params verbatim to
 * the service, and that the service's resolved value is returned
 * unmodified — no projection or shape rewrite at the controller layer.
 *
 *   - GET /                  → forwards (userId), returns the list response
 *   - POST /                 → forwards (userId, body), returns the created row
 *   - PATCH /:id             → forwards (userId, id, body), returns the row
 *   - DELETE /:id            → forwards (userId, id), resolves void (204)
 *   - admin principals       → controller pins reads to admin's own userId
 *                              (admin-impersonation is a separate audited
 *                              surface not in Phase 18)
 */
import { describe, expect, it } from 'vitest';
import { AddressesController } from './addresses.controller.js';
import type { AddressesService } from './addresses.service.js';
import type {
  CreateAddressRequestDto,
  ListAddressesResponse,
  PatchAddressRequestDto,
  UserAddressResponse,
} from './dto/index.js';
import type { AuthenticatedUser } from '../auth/guards/auth-types.js';

const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const ADDRESS_ID = '01935f3d-0000-7000-8000-000000000020';

const PRINCIPAL: AuthenticatedUser = {
  userId: USER_ID,
  sessionId: '01935f3d-0000-7000-8000-000000000002',
  role: 'customer',
};

const ROW: UserAddressResponse = {
  id: ADDRESS_ID,
  label: 'Home',
  line1: '100 Nicollet Mall',
  line2: null,
  city: 'Minneapolis',
  region: 'MN',
  postalCode: '55401',
  country: 'US',
  location: { latitude: 44.97, longitude: -93.27 },
  isDefault: true,
  isValidated: false,
  validatedAt: null,
  deliveryInstructions: null,
  createdAt: '2026-05-15T18:00:00.000Z',
  updatedAt: '2026-05-15T18:00:00.000Z',
};

const LIST: ListAddressesResponse = { addresses: [ROW] };

class FakeAddressesService {
  public listCalls: { userId: string }[] = [];
  public createCalls: { userId: string; body: CreateAddressRequestDto }[] = [];
  public updateCalls: { userId: string; id: string; body: PatchAddressRequestDto }[] = [];
  public removeCalls: { userId: string; id: string }[] = [];

  listForUser = (userId: string): Promise<ListAddressesResponse> => {
    this.listCalls.push({ userId });
    return Promise.resolve(LIST);
  };

  create = (userId: string, body: CreateAddressRequestDto): Promise<UserAddressResponse> => {
    this.createCalls.push({ userId, body });
    return Promise.resolve(ROW);
  };

  update = (
    userId: string,
    id: string,
    body: PatchAddressRequestDto,
  ): Promise<UserAddressResponse> => {
    this.updateCalls.push({ userId, id, body });
    return Promise.resolve(ROW);
  };

  remove = (userId: string, id: string): Promise<void> => {
    this.removeCalls.push({ userId, id });
    return Promise.resolve();
  };
}

function makeController(): {
  controller: AddressesController;
  service: FakeAddressesService;
} {
  const service = new FakeAddressesService();
  const controller = new AddressesController(service as unknown as AddressesService);
  return { controller, service };
}

describe('AddressesController', () => {
  it('GET / forwards the principal userId and returns the service response', async () => {
    const { controller, service } = makeController();

    const result = await controller.list(PRINCIPAL);

    expect(result).toBe(LIST);
    expect(service.listCalls).toEqual([{ userId: USER_ID }]);
  });

  it('POST / forwards the principal userId and the parsed body', async () => {
    const { controller, service } = makeController();
    const body: CreateAddressRequestDto = {
      label: 'Home',
      line1: '100 Nicollet Mall',
      city: 'Minneapolis',
      region: 'MN',
      postalCode: '55401',
      country: 'US',
      latitude: 44.97,
      longitude: -93.27,
      setAsDefault: true,
    };

    const result = await controller.create(PRINCIPAL, body);

    expect(result).toBe(ROW);
    expect(service.createCalls).toEqual([{ userId: USER_ID, body }]);
  });

  it('PATCH /:id forwards the principal userId, the path param, and the body', async () => {
    const { controller, service } = makeController();
    const body: PatchAddressRequestDto = { label: 'Renamed', isDefault: true };

    const result = await controller.update(PRINCIPAL, ADDRESS_ID, body);

    expect(result).toBe(ROW);
    expect(service.updateCalls).toEqual([{ userId: USER_ID, id: ADDRESS_ID, body }]);
  });

  it('DELETE /:id forwards the principal userId and the path param', async () => {
    const { controller, service } = makeController();

    const result = await controller.remove(PRINCIPAL, ADDRESS_ID);

    expect(result).toBeUndefined();
    expect(service.removeCalls).toEqual([{ userId: USER_ID, id: ADDRESS_ID }]);
  });

  it('PATCH /:id pins reads to the principal userId even for admin support principals', async () => {
    // Admin/superadmin reach the same endpoint, but the controller still
    // pins writes to the principal's own userId — admin-impersonation
    // (editing on behalf of a user) is a separate, audited surface not
    // in Phase 18.
    const { controller, service } = makeController();
    const admin: AuthenticatedUser = {
      userId: '01935f3d-0000-7000-8000-0000000000aa',
      sessionId: 'sess-admin',
      role: 'admin',
    };

    await controller.update(admin, ADDRESS_ID, { label: 'Renamed' });

    expect(service.updateCalls[0]?.userId).toBe(admin.userId);
  });
});
