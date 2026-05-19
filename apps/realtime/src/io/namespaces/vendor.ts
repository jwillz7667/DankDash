/**
 * /vendor namespace.
 *
 * A vendor user can be on the staff of multiple dispensaries (multi-shop
 * operators are common). We auto-join every active membership at connect
 * time so the user receives notifications for every shop they manage
 * without per-shop reconnection. Explicit join/leave handlers are NOT
 * exposed — membership is the only source of truth.
 *
 * The handshake auth (`socket.handshake.auth.dispensaryId`) is an
 * optional preferences hint, not authorization. If supplied, we only
 * join that single room (the vendor portal sends it to scope a
 * single-shop session). If absent, we join all memberships.
 */
import { ForbiddenError } from '@dankdash/types';
import { createAuthMiddleware, getSocketData } from '../auth-middleware.js';
import { dispensaryRoom } from '../rooms.js';
import type { RealtimeJwtVerifier } from '../../auth/jwt.js';
import type { MembershipRepository } from '../../membership/repo.js';
import type { Logger } from '@dankdash/config';
import type { Namespace, Socket } from 'socket.io';

export interface VendorNamespaceOptions {
  readonly verifier: RealtimeJwtVerifier;
  readonly membership: MembershipRepository;
  readonly logger: Logger;
}

export function registerVendorNamespace(nsp: Namespace, options: VendorNamespaceOptions): void {
  nsp.use(
    createAuthMiddleware({
      verifier: options.verifier,
      allowedRole: 'vendor',
      logger: options.logger,
    }),
  );

  // Second middleware: resolves the dispensary memberships. Splitting it
  // off from auth keeps the auth path pure (no DB hit) and isolates a
  // membership-lookup failure as a distinct error type the client can
  // distinguish from a stale-token failure.
  nsp.use((socket, next) => {
    resolveVendorMemberships(socket, options)
      .then(() => {
        next();
      })
      .catch((err: unknown) => {
        const { claims } = getSocketData(socket);
        options.logger.info(
          {
            event: 'realtime.vendor.membership.rejected',
            userId: claims.sub,
            err: err instanceof Error ? err.message : String(err),
          },
          'realtime: vendor membership rejected',
        );
        const wrapped =
          err instanceof Error
            ? Object.assign(err, { data: { code: 'FORBIDDEN' } })
            : new Error('membership lookup failed');
        next(wrapped);
      });
  });

  nsp.on('connection', (socket) => {
    const { claims } = getSocketData(socket);
    const data = socket.data as Partial<{ dispensaryIds: readonly string[] }>;
    const dispensaryIds = data.dispensaryIds ?? [];
    for (const id of dispensaryIds) {
      void socket.join(dispensaryRoom(id));
    }
    options.logger.info(
      {
        event: 'realtime.vendor.connected',
        userId: claims.sub,
        socketId: socket.id,
        dispensaryCount: dispensaryIds.length,
      },
      'realtime: vendor connected',
    );

    socket.on('disconnect', (reason) => {
      options.logger.info(
        {
          event: 'realtime.vendor.disconnected',
          userId: claims.sub,
          socketId: socket.id,
          reason,
        },
        'realtime: vendor disconnected',
      );
    });
  });
}

async function resolveVendorMemberships(
  socket: Socket,
  options: VendorNamespaceOptions,
): Promise<void> {
  const { claims } = getSocketData(socket);
  const handshakeAuth = socket.handshake.auth as Record<string, unknown>;
  const requested = handshakeAuth['dispensaryId'];
  const data = socket.data as { dispensaryIds?: readonly string[] };

  if (typeof requested === 'string' && requested.length > 0) {
    const ok = await options.membership.isStaffOfDispensary(claims.sub, requested);
    if (!ok) {
      throw new ForbiddenError('not a staff member of requested dispensary', {
        dispensaryId: requested,
      });
    }
    data.dispensaryIds = [requested];
    return;
  }

  const memberships = await options.membership.listStaffDispensariesForUser(claims.sub);
  if (memberships.length === 0) {
    throw new ForbiddenError('user has no active dispensary memberships');
  }
  data.dispensaryIds = memberships;
}
