/**
 * Drivers feature module.
 *
 * Owns the full driver surface:
 *   - admin onboarding write surface (POST/PATCH /v1/admin/drivers)
 *   - driver-self shift + status surface (POST /v1/driver/shift/{start,end},
 *     POST /v1/driver/status)
 *   - driver-self offers surface (accept/decline dispatch offers)
 *   - driver-self app surface (DriverAppController)
 *   - driver-orders surface (Phase 20):
 *       GET  /v1/driver/orders/:id
 *       POST /v1/driver/orders/:id/pickup-confirm
 *       POST /v1/driver/orders/:id/delivery-confirm   (ID-scan gated)
 *       POST /v1/driver/orders/:id/id-scan-session    (Veriff)
 *       POST /v1/driver/orders/:id/id-scan-result     (Veriff)
 *       POST /v1/webhooks/veriff                      (Veriff push)
 *       GET  /v1/driver/earnings                      (bucketed totals)
 *       POST /v1/driver/cashout                       (Aeropay-gated)
 *   - DriverContextGuard, exported so future driver-self modules can
 *     `@UseGuards(DriverContextGuard)` without re-declaring the guard's
 *     repo provider
 *
 * The DocumentHasher provider is global (DocumentHashModule registered
 * in AppModule), so AdminDriversService only injects the token — no
 * local provider needed here.
 *
 * Repository providers use the same FactoryProvider pattern as the rest
 * of the codebase: each repo is a thin wrapper around the shared
 * Database, so a single instance per process is safe; scoped repos for
 * transactions are constructed inline by the service via the
 * `scopedReposFor` factory closure.
 *
 * AuthModule import gives the admin controller access to RolesGuard;
 * JwtAuthGuard is already bound globally in the root composition.
 *
 * OrdersModule is imported so the offer-accept, driver-orders pickup-
 * /delivery-confirm, and ID-scan flows can inject OrderTransitionService
 * — the canonical status-transition path with Redis publish + realtime
 * fan-out. Calling `OrdersRepository.transitionStatus` directly would
 * skip the publish and break the iOS / portal live status update.
 *
 * IdentityVerificationModule provides VeriffClient for the ID-scan
 * session + decision flows. The Veriff webhook controller lives here
 * (not in identity-verification) so the dependency graph stays one-
 * way: drivers → identity-verification.
 *
 * PaymentsModule is imported so the live cashout gateway can inject
 * the shared AEROPAY_CLIENT token without re-wiring the auth / undici
 * chain — same singleton the payment-methods + refunds surfaces use.
 * The stub gateway needs nothing from PaymentsModule, but the live
 * wrapper does; importing once keeps the future flip a single env-
 * flag change.
 */
import {
  AgeVerificationsRepository,
  DispatchOffersRepository,
  DispensariesRepository,
  DriverLocationHistoryRepository,
  DriverShiftsRepository,
  DriversRepository,
  OrderEventsRepository,
  OrderItemsRepository,
  OrdersRepository,
  PayoutsRepository,
  UsersRepository,
  type Database,
  type DocumentHasher,
} from '@dankdash/db';
import { Module, type FactoryProvider, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DOCUMENT_HASHER, DocumentHashModule } from '../../infrastructure/document-hash.module.js';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { IdentityVerificationModule } from '../identity-verification/identity-verification.module.js';
import { VeriffClient } from '../identity-verification/veriff.client.js';
import { OrderTransitionService } from '../orders/order-transition.service.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AEROPAY_CLIENT, type AeropayClientLike } from '../payments/tokens.js';
import { AdminDriversController } from './admin/admin-drivers.controller.js';
import {
  AdminDriversService,
  type AdminDriverScopedRepos,
  type AdminDriverScopedReposFactory,
} from './admin/admin-drivers.service.js';
import { DriverAppController } from './app/driver-app.controller.js';
import { DriverAppService } from './app/driver-app.service.js';
import { DriverContextGuard } from './context/driver-context.guard.js';
import { DriverCashoutController } from './controllers/driver-cashout.controller.js';
import { DriverEarningsController } from './controllers/driver-earnings.controller.js';
import { DriverOrdersController } from './controllers/driver-orders.controller.js';
import { VeriffWebhookController } from './controllers/veriff-webhook.controller.js';
import { DriverOffersController } from './offers/driver-offers.controller.js';
import {
  DriverOffersService,
  type DriverOffersScopedRepos,
  type DriverOffersScopedReposFactory,
} from './offers/driver-offers.service.js';
import {
  LiveAeropayDriverPayoutGateway,
  StubAeropayDriverPayoutGateway,
} from './services/aeropay-driver-payout.gateway.js';
import {
  DriverCashoutService,
  type AeropayDriverPayoutGateway,
  type DriverCashoutScopedRepos,
} from './services/driver-cashout.service.js';
import {
  DriverEarningsService,
  type DriverEarningsScopedRepos,
} from './services/driver-earnings.service.js';
import {
  DriverIdScanService,
  type DriverIdScanScopedRepos,
} from './services/driver-id-scan.service.js';
import {
  DriverOrdersService,
  type DriverOrdersScopedRepos,
} from './services/driver-orders.service.js';
import { DriverShiftController } from './shift/driver-shift.controller.js';
import {
  DriverShiftService,
  type DriverShiftScopedRepos,
  type DriverShiftScopedReposFactory,
} from './shift/driver-shift.service.js';

const DRIVER_PAYOUT_GATEWAY = Symbol.for('DRIVER_PAYOUT_GATEWAY');

const driversRepoProvider: FactoryProvider<DriversRepository> = {
  provide: DriversRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DriversRepository => new DriversRepository(db),
};

const driverShiftsRepoProvider: FactoryProvider<DriverShiftsRepository> = {
  provide: DriverShiftsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DriverShiftsRepository => new DriverShiftsRepository(db),
};

const driverLocationHistoryRepoProvider: FactoryProvider<DriverLocationHistoryRepository> = {
  provide: DriverLocationHistoryRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DriverLocationHistoryRepository =>
    new DriverLocationHistoryRepository(db),
};

const dispatchOffersRepoProvider: FactoryProvider<DispatchOffersRepository> = {
  provide: DispatchOffersRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DispatchOffersRepository => new DispatchOffersRepository(db),
};

const usersRepoProvider: FactoryProvider<UsersRepository> = {
  provide: UsersRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): UsersRepository => new UsersRepository(db),
};

const adminDriverReposFor: AdminDriverScopedReposFactory = (
  db: Database,
): AdminDriverScopedRepos => ({
  drivers: new DriversRepository(db),
  users: new UsersRepository(db),
});

const adminDriversServiceProvider: FactoryProvider<AdminDriversService> = {
  provide: AdminDriversService,
  inject: [DriversRepository, UsersRepository, DRIZZLE_DB, DOCUMENT_HASHER],
  useFactory: (
    drivers: DriversRepository,
    users: UsersRepository,
    db: Database,
    hasher: DocumentHasher,
  ): AdminDriversService =>
    new AdminDriversService(drivers, users, db, adminDriverReposFor, hasher),
};

const driverShiftReposFor: DriverShiftScopedReposFactory = (
  db: Database,
): DriverShiftScopedRepos => ({
  drivers: new DriversRepository(db),
  shifts: new DriverShiftsRepository(db),
});

const driverShiftServiceProvider: FactoryProvider<DriverShiftService> = {
  provide: DriverShiftService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DriverShiftService => new DriverShiftService(db, driverShiftReposFor),
};

const driverOffersReposFor: DriverOffersScopedReposFactory = (
  db: Database,
): DriverOffersScopedRepos => ({
  dispatchOffers: new DispatchOffersRepository(db),
  drivers: new DriversRepository(db),
});

const driverOffersServiceProvider: FactoryProvider<DriverOffersService> = {
  provide: DriverOffersService,
  inject: [DRIZZLE_DB, OrderTransitionService, EventEmitter2],
  useFactory: (
    db: Database,
    orderTransitions: OrderTransitionService,
    events: EventEmitter2,
  ): DriverOffersService =>
    new DriverOffersService(db, orderTransitions, driverOffersReposFor, events),
};

const ordersRepoProvider: FactoryProvider<OrdersRepository> = {
  provide: OrdersRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): OrdersRepository => new OrdersRepository(db),
};

const dispensariesRepoProvider: FactoryProvider<DispensariesRepository> = {
  provide: DispensariesRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DispensariesRepository => new DispensariesRepository(db),
};

const driverAppServiceProvider: FactoryProvider<DriverAppService> = {
  provide: DriverAppService,
  inject: [DriversRepository, OrdersRepository, DispensariesRepository, DriverShiftsRepository],
  useFactory: (
    drivers: DriversRepository,
    orders: OrdersRepository,
    dispensaries: DispensariesRepository,
    shifts: DriverShiftsRepository,
  ): DriverAppService => new DriverAppService(drivers, orders, dispensaries, shifts),
};

const driverOrdersServiceProvider: FactoryProvider<DriverOrdersService> = {
  provide: DriverOrdersService,
  inject: [DRIZZLE_DB, OrderTransitionService],
  useFactory: (db: Database, orderTransitions: OrderTransitionService): DriverOrdersService =>
    new DriverOrdersService(
      db,
      (scopedDb): DriverOrdersScopedRepos => ({
        orders: new OrdersRepository(scopedDb),
        orderItems: new OrderItemsRepository(scopedDb),
        orderEvents: new OrderEventsRepository(scopedDb),
        users: new UsersRepository(scopedDb),
        dispensaries: new DispensariesRepository(scopedDb),
      }),
      orderTransitions,
    ),
};

const driverIdScanServiceProvider: FactoryProvider<DriverIdScanService> = {
  provide: DriverIdScanService,
  inject: [DRIZZLE_DB, OrderTransitionService, VeriffClient, ConfigService],
  useFactory: (
    db: Database,
    orderTransitions: OrderTransitionService,
    veriff: VeriffClient,
    config: ConfigService,
  ): DriverIdScanService =>
    new DriverIdScanService(
      db,
      (scopedDb): DriverIdScanScopedRepos => ({
        orders: new OrdersRepository(scopedDb),
        users: new UsersRepository(scopedDb),
        ageVerifications: new AgeVerificationsRepository(scopedDb),
      }),
      veriff,
      orderTransitions,
      {
        webhookBaseUrl: config.get<string>('CHECKOUT_BASE_URL') ?? 'https://app.dankdash.com',
      },
    ),
};

const ageVerificationsRepoProvider: FactoryProvider<AgeVerificationsRepository> = {
  provide: AgeVerificationsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): AgeVerificationsRepository => new AgeVerificationsRepository(db),
};

const driverEarningsServiceProvider: FactoryProvider<DriverEarningsService> = {
  provide: DriverEarningsService,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DriverEarningsService =>
    new DriverEarningsService(
      db,
      (scopedDb): DriverEarningsScopedRepos => ({
        orders: new OrdersRepository(scopedDb),
      }),
    ),
};

/**
 * Stub-vs-live selection. `AEROPAY_LIVE=false` (default) returns the
 * persisted-only stub. `AEROPAY_LIVE=true` wraps the real
 * `AeropayClient.createPayout` — the live branch currently throws
 * `PAYMENT_METHOD_INVALID` because the driver-side bank-link flow is
 * a future phase; wiring this here keeps the eventual flip to a
 * single env change.
 */
const driverPayoutGatewayProvider: FactoryProvider<AeropayDriverPayoutGateway> = {
  provide: DRIVER_PAYOUT_GATEWAY,
  inject: [ConfigService, AEROPAY_CLIENT],
  useFactory: (config: ConfigService, aeropay: AeropayClientLike): AeropayDriverPayoutGateway => {
    const live = config.get<boolean>('AEROPAY_LIVE') ?? false;
    return live
      ? new LiveAeropayDriverPayoutGateway({ aeropay })
      : new StubAeropayDriverPayoutGateway();
  },
};

const driverCashoutServiceProvider: FactoryProvider<DriverCashoutService> = {
  provide: DriverCashoutService,
  inject: [DRIZZLE_DB, DRIVER_PAYOUT_GATEWAY],
  useFactory: (db: Database, gateway: AeropayDriverPayoutGateway): DriverCashoutService =>
    new DriverCashoutService(
      db,
      (scopedDb): DriverCashoutScopedRepos => ({
        orders: new OrdersRepository(scopedDb),
        payouts: new PayoutsRepository(scopedDb),
      }),
      gateway,
    ),
};

const providers: Provider[] = [
  driversRepoProvider,
  driverShiftsRepoProvider,
  driverLocationHistoryRepoProvider,
  dispatchOffersRepoProvider,
  usersRepoProvider,
  ordersRepoProvider,
  dispensariesRepoProvider,
  ageVerificationsRepoProvider,
  adminDriversServiceProvider,
  driverShiftServiceProvider,
  driverOffersServiceProvider,
  driverAppServiceProvider,
  driverOrdersServiceProvider,
  driverIdScanServiceProvider,
  driverEarningsServiceProvider,
  driverPayoutGatewayProvider,
  driverCashoutServiceProvider,
  DriverContextGuard,
];

@Module({
  imports: [
    AuthModule,
    DocumentHashModule,
    OrdersModule,
    IdentityVerificationModule,
    PaymentsModule,
  ],
  controllers: [
    AdminDriversController,
    DriverShiftController,
    DriverOffersController,
    DriverAppController,
    DriverOrdersController,
    VeriffWebhookController,
    DriverEarningsController,
    DriverCashoutController,
  ],
  providers,
  exports: [
    AdminDriversService,
    DriverShiftService,
    DriverOffersService,
    DriverAppService,
    DriverOrdersService,
    DriverIdScanService,
    DriverEarningsService,
    DriverCashoutService,
    DriversRepository,
    DriverShiftsRepository,
    DriverLocationHistoryRepository,
    DispatchOffersRepository,
    DriverContextGuard,
  ],
})
export class DriversModule {}
