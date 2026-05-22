/**
 * /customer namespace.
 *
 * One room per user (`user:{sub}`). The auto-join is implicit — the JWT
 * `sub` is the identity, the client never asks for a different room, so
 * impersonation is structurally impossible. Future expansion (e.g. a
 * customer joining an `order:{id}` room for richer feeds) goes through
 * an explicit join handler with authz against the orders module.
 */
import { createAuthMiddleware, getSocketData } from '../auth-middleware.js';
import { userRoom } from '../rooms.js';
import type { RealtimeJwtVerifier } from '../../auth/jwt.js';
import type { Logger } from '@dankdash/config';
import type { Namespace } from 'socket.io';

export interface CustomerNamespaceOptions {
  readonly verifier: RealtimeJwtVerifier;
  readonly logger: Logger;
}

export function registerCustomerNamespace(nsp: Namespace, options: CustomerNamespaceOptions): void {
  nsp.use(
    createAuthMiddleware({
      verifier: options.verifier,
      allowedRole: 'customer',
      logger: options.logger,
    }),
  );

  nsp.on('connection', (socket) => {
    const { claims } = getSocketData(socket);
    const room = userRoom(claims.sub);
    void socket.join(room);
    options.logger.info(
      {
        event: 'realtime.customer.connected',
        userId: claims.sub,
        room,
        socketId: socket.id,
      },
      'realtime: customer connected',
    );

    socket.on('disconnect', (reason) => {
      options.logger.info(
        {
          event: 'realtime.customer.disconnected',
          userId: claims.sub,
          socketId: socket.id,
          reason,
        },
        'realtime: customer disconnected',
      );
    });
  });
}
