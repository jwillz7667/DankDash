/**
 * Drivers feature module.
 *
 * Owns:
 *   - admin onboarding write surface (POST/PATCH /v1/admin/drivers)
 *   - driver-self shift + status surface (POST /v1/driver/shift/{start,end},
 *     POST /v1/driver/status)
 *   - DriverContextGuard, exported so future driver-self modules
 *     (offers, route) can `@UseGuards(DriverContextGuard)` without
 *     re-declaring the guard's repo provider
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
 */
import {
  DispatchOffersRepository,
  DriverLocationHistoryRepository,
  DriverShiftsRepository,
  DriversRepository,
  UsersRepository,
  type Database,
  type DocumentHasher,
} from '@dankdash/db';
import { Module, type FactoryProvider, type Provider } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DOCUMENT_HASHER, DocumentHashModule } from '../../infrastructure/document-hash.module.js';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { OrderTransitionService } from '../orders/order-transition.service.js';
import { OrdersModule } from '../orders/orders.module.js';
import { AdminDriversController } from './admin/admin-drivers.controller.js';
import {
  AdminDriversService,
  type AdminDriverScopedRepos,
  type AdminDriverScopedReposFactory,
} from './admin/admin-drivers.service.js';
import { DriverContextGuard } from './context/driver-context.guard.js';
import { DriverOffersController } from './offers/driver-offers.controller.js';
import {
  DriverOffersService,
  type DriverOffersScopedRepos,
  type DriverOffersScopedReposFactory,
} from './offers/driver-offers.service.js';
import { DriverShiftController } from './shift/driver-shift.controller.js';
import {
  DriverShiftService,
  type DriverShiftScopedRepos,
  type DriverShiftScopedReposFactory,
} from './shift/driver-shift.service.js';

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

// Closure factory used by AdminDriversService.create so the drivers insert
// and the user role-promotion run inside one tx. Stateless — the same
// closure is reused for every onboarding call; only the `db` (tx handle)
// passed in changes.
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

// Sibling factory for the driver-self shift surface. Same shape as the
// admin one but only needs (drivers, shifts) inside the tx — no users
// table write, since promoting role=driver already happened at onboarding.
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

// Per-tx repo bundle for the offer accept/decline service. The accept flow
// composes offer + driver + (via OrderTransitionService.transitionWithinTx)
// order writes into one outer tx, so all repos here must be re-bound to
// the tx handle the closure receives.
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

const providers: Provider[] = [
  driversRepoProvider,
  driverShiftsRepoProvider,
  driverLocationHistoryRepoProvider,
  dispatchOffersRepoProvider,
  usersRepoProvider,
  adminDriversServiceProvider,
  driverShiftServiceProvider,
  driverOffersServiceProvider,
  DriverContextGuard,
];

@Module({
  imports: [AuthModule, DocumentHashModule, OrdersModule],
  controllers: [AdminDriversController, DriverShiftController, DriverOffersController],
  providers,
  exports: [
    AdminDriversService,
    DriverShiftService,
    DriverOffersService,
    DriversRepository,
    DriverShiftsRepository,
    DriverLocationHistoryRepository,
    DispatchOffersRepository,
    DriverContextGuard,
  ],
})
export class DriversModule {}
