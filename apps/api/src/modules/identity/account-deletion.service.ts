/**
 * Account deletion — the irreversible "delete my account" flow behind
 * DELETE /v1/me.
 *
 * Deletion is a cross-cutting orchestration (identity + sessions + addresses
 * + payment methods + orders), so it lives in its own service rather than
 * bloating IdentityService. It follows the same ScopedReposFactory pattern as
 * CartService / AddressesService: the DI container supplies the singleton
 * `Database`, the factory builds tx-bound repositories on demand, and the
 * whole deletion runs inside one `db.transaction(...)` so a partial deletion
 * (PII scrubbed but sessions still live, or addresses gone but the user row
 * intact) can never be observed.
 *
 * Why deletion is anonymize-and-retain rather than a hard DELETE:
 *   - Orders (5yr, OCM), financial records (7yr, IRS), and age-verification
 *     scans (7yr) carry statutory retention. They FK the user with ON DELETE
 *     RESTRICT, so a row DELETE is impossible anyway.
 *   - Soft-delete (UPDATE `deleted_at`) keeps those rows valid while the
 *     identity root is anonymized — the retained records reference a shell
 *     that no longer identifies a person.
 *
 * Why active orders block deletion:
 *   - A delivery in flight carries a settled payment, reserved inventory, a
 *     possibly-dispatched driver, and a mandatory, non-bypassable ID scan at
 *     handoff. Anonymizing the customer mid-flight would orphan a regulated
 *     delivery, so we refuse with 409 until the order reaches a terminal
 *     state. (The residual race — an order placed in the microsecond between
 *     the count and the commit — is negligible: checkout and deletion are
 *     distinct user gestures, and the worst case is a single order tied to a
 *     shell, which the next reconciliation surfaces.)
 */
import {
  type Database,
  type FavoritesRepository,
  type OrdersRepository,
  type PasswordResetTokensRepository,
  type PaymentMethodsRepository,
  type SessionsRepository,
  type UserAddressesRepository,
  type UsersRepository,
} from '@dankdash/db';
import { ConflictError, NotFoundError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import type { AccountDeletionResponse } from './dto/index.js';

export interface AccountDeletionScopedRepos {
  readonly users: UsersRepository;
  readonly sessions: SessionsRepository;
  readonly passwordResetTokens: PasswordResetTokensRepository;
  readonly userAddresses: UserAddressesRepository;
  readonly paymentMethods: PaymentMethodsRepository;
  readonly orders: OrdersRepository;
  readonly favorites: FavoritesRepository;
}

export type AccountDeletionScopedReposFactory = (db: Database) => AccountDeletionScopedRepos;

@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly db: Database,
    private readonly reposFor: AccountDeletionScopedReposFactory,
  ) {}

  async deleteAccount(userId: string): Promise<AccountDeletionResponse> {
    return this.db.transaction(async (tx) => {
      const repos = this.reposFor(tx);

      const user = await repos.users.findById(userId);
      // Unknown or already-deleted user → 404. Same shape for both so a probe
      // cannot distinguish "never existed" from "already gone". Idempotent:
      // a second delete is a no-op 404, not a 500. (`user?.deletedAt !== null`
      // is true for a missing user — undefined — and for an already-tombstoned
      // one, and false only for a live account.)
      if (user?.deletedAt !== null) {
        throw new NotFoundError('User', userId);
      }

      const activeOrders = await repos.orders.countActiveForUser(userId);
      if (activeOrders > 0) {
        throw new ConflictError(
          'ACCOUNT_HAS_ACTIVE_ORDERS',
          'Your account cannot be deleted while you have an order in progress. ' +
            'Please wait until it is delivered or canceled, then try again.',
          { activeOrders },
        );
      }

      // Log out everywhere and kill credential-recovery vectors. Inside the
      // tx, so an in-flight refresh/reset racing the delete loses at commit.
      await repos.sessions.revokeAllForUser(userId);
      await repos.passwordResetTokens.invalidateAllActiveForUser(userId);

      // PII teardown on the user's owned, non-statutory records.
      await repos.userAddresses.softDeleteAllForUser(userId);
      await repos.paymentMethods.softDeleteAllForUser(userId);
      // Favorites carry no statutory retention and no PII — hard-delete them
      // outright so nothing dangles for the anonymized shell.
      await repos.favorites.deleteAllForUser(userId);

      // Anonymize the identity root + soft-delete. The repo's `deleted_at IS
      // NULL` guard returns null if a concurrent delete won the race → abort
      // the tx. A returned row always carries a non-null `deletedAt`; the
      // nullish check both handles the race and narrows the type for the
      // ISO serialization below.
      const anonymized = await repos.users.anonymizeAndSoftDelete(userId);
      if (anonymized?.deletedAt == null) {
        throw new NotFoundError('User', userId);
      }

      return { deletedAt: anonymized.deletedAt.toISOString() };
    });
  }
}
