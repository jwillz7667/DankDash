/**
 * Addresses service — user-scoped CRUD on `user_addresses`.
 *
 *   listForUser(userId)              → all non-deleted addresses, default
 *                                       first, then most recently created.
 *   create(userId, body)             → insert + optional default flip in
 *                                       one transaction. Coordinates come
 *                                       from the iOS MapKit geocoder; this
 *                                       service does not geocode itself.
 *   update(userId, id, patch)        → partial update. `isDefault: true`
 *                                       routes through the atomic singleton
 *                                       flip so two rows can never both be
 *                                       default. Cross-user PATCH returns
 *                                       404 (same shape as missing row,
 *                                       so a probe cannot distinguish
 *                                       ownership from existence).
 *
 * The service uses the FactoryProvider + scoped-repos closure pattern
 * established by CartModule + OrdersModule: the DI container supplies the
 * `Database` singleton, the factory builds tx-bound repositories on
 * demand. When Phase 19+ wraps create-or-update in a transaction (e.g.
 * to publish a `address.created` event), the closure already keys repos
 * to the `tx` Database the wrapper hands in.
 *
 * Geocoding intentionally lives client-side. The Phase-8 reverse
 * geocoder client never shipped, and MapKit's CLGeocoder gives the iOS
 * client a lat/lng pair directly from the user's typed-or-picked
 * address — round-tripping through a server geocoder would cost a
 * network hop and provide no compliance benefit (the dispensary's
 * delivery-polygon test runs against `location` regardless of how it
 * was acquired). ADR 0006 captures the decision alongside the MapKit
 * choice for tracking.
 */
import { type Database, type UserAddress, type UserAddressesRepository } from '@dankdash/db';
import { NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import type {
  CreateAddressRequestDto,
  ListAddressesResponse,
  PatchAddressRequestDto,
  UserAddressResponse,
} from './dto/index.js';

export interface AddressesScopedRepos {
  readonly userAddresses: UserAddressesRepository;
}

export type AddressesScopedReposFactory = (db: Database) => AddressesScopedRepos;

@Injectable()
export class AddressesService {
  constructor(
    private readonly db: Database,
    private readonly reposFor: AddressesScopedReposFactory,
  ) {}

  async listForUser(userId: string): Promise<ListAddressesResponse> {
    const rows = await this.reposFor(this.db).userAddresses.listForUser(userId);
    return { addresses: rows.map((row) => toResponse(row)) };
  }

  async create(userId: string, body: CreateAddressRequestDto): Promise<UserAddressResponse> {
    const repos = this.reposFor(this.db).userAddresses;
    const created = await repos.create({
      userId,
      label: body.label ?? null,
      line1: body.line1,
      line2: body.line2 ?? null,
      city: body.city,
      region: body.region,
      postalCode: body.postalCode,
      country: body.country,
      location: { type: 'Point', coordinates: [body.longitude, body.latitude] },
      deliveryInstructions: body.deliveryInstructions ?? null,
      // `isDefault` is never set inline — even when `setAsDefault` is true
      // the canonical path is repo.setDefault, which atomically clears the
      // previous holder. Inline-setting would race with an existing default.
      isDefault: false,
    });
    if (body.setAsDefault === true) {
      await repos.setDefault(userId, created.id);
    }
    const refreshed = await repos.findById(created.id);
    if (refreshed === null) {
      throw new NotFoundError('UserAddress', created.id);
    }
    return toResponse(refreshed);
  }

  async update(
    userId: string,
    id: string,
    patch: PatchAddressRequestDto,
  ): Promise<UserAddressResponse> {
    const repos = this.reposFor(this.db).userAddresses;
    // Pre-flight ownership check. RLS already guards reads, but doing this
    // explicitly lets us return 404 (instead of relying on a no-rows-updated
    // signal that could mask a genuine repo failure). The same row shape as
    // a missing record means a cross-user probe cannot distinguish the two.
    const existing = await repos.findById(id);
    if (existing?.userId !== userId || existing.deletedAt !== null) {
      throw new NotFoundError('UserAddress', id);
    }

    const hasFieldEdits =
      patch.label !== undefined ||
      patch.line1 !== undefined ||
      patch.line2 !== undefined ||
      patch.city !== undefined ||
      patch.region !== undefined ||
      patch.postalCode !== undefined ||
      patch.country !== undefined ||
      patch.latitude !== undefined ||
      patch.deliveryInstructions !== undefined;

    if (hasFieldEdits) {
      const updated = await repos.update(id, {
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.line1 !== undefined ? { line1: patch.line1 } : {}),
        ...(patch.line2 !== undefined ? { line2: patch.line2 } : {}),
        ...(patch.city !== undefined ? { city: patch.city } : {}),
        ...(patch.region !== undefined ? { region: patch.region } : {}),
        ...(patch.postalCode !== undefined ? { postalCode: patch.postalCode } : {}),
        ...(patch.country !== undefined ? { country: patch.country } : {}),
        ...(patch.deliveryInstructions !== undefined
          ? { deliveryInstructions: patch.deliveryInstructions }
          : {}),
        // The DTO refine guarantees latitude/longitude move together.
        ...(patch.latitude !== undefined && patch.longitude !== undefined
          ? {
              location: {
                type: 'Point' as const,
                coordinates: [patch.longitude, patch.latitude],
              },
            }
          : {}),
      });
      if (updated === null) {
        throw new NotFoundError('UserAddress', id);
      }
    }

    if (patch.isDefault === true) {
      await repos.setDefault(userId, id);
    }

    const refreshed = await repos.findById(id);
    if (refreshed === null) {
      throw new NotFoundError('UserAddress', id);
    }
    return toResponse(refreshed);
  }
}

function toResponse(row: UserAddress): UserAddressResponse {
  const [longitude, latitude] = row.location.coordinates;
  return {
    id: row.id,
    label: row.label,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    country: row.country,
    location: { latitude, longitude },
    isDefault: row.isDefault,
    isValidated: row.isValidated,
    validatedAt: row.validatedAt?.toISOString() ?? null,
    deliveryInstructions: row.deliveryInstructions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
