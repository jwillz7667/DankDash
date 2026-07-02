/**
 * Notifications feature module.
 *
 * Composes:
 *   - The `/v1/me/push-tokens` HTTP surface (PushTokensController +
 *     PushTokensService) so iOS apps can register/deactivate APNs tokens.
 *   - The APNs/Twilio/Resend provider singletons from @dankdash/notifications.
 *   - The NotificationDispatcher — single fan-out chokepoint with Redis-
 *     backed 24h dedup that every notification event flows through.
 *   - The OrderNotificationsListener — subscribes to
 *     `ORDER_TRANSITIONED_EVENT` and routes each transition to the right
 *     template + payload.
 *
 * Provider construction is gated by env. APNs is always-on (its creds
 * are required at boot). Twilio and Resend are toggled by `ENABLE_TWILIO`
 * and `ENABLE_RESEND` (default `true`): when the flag is `false` the
 * factory installs a `NullNotificationProvider` that records every send
 * as a non-retryable skip on the notification row, so the order
 * lifecycle continues without crashing for a deployment that hasn't yet
 * acquired Twilio/Resend credentials. When the flag is `true`, each
 * `getOrThrow` enforces the credentials' presence — fail-fast at boot.
 *
 * Repository wiring follows the FactoryProvider pattern the rest of the
 * API uses (see compliance.module.ts, payments.module.ts).
 *
 * AuthModule is imported so the controller's `RolesGuard` resolves the
 * same `RolesReflector` the global JwtAuthGuard already populated.
 */
import {
  DispensariesRepository,
  DispensaryStaffRepository,
  DriversRepository,
  NotificationPreferencesRepository,
  NotificationsRepository,
  PushTokensRepository,
  UsersRepository,
  OrdersRepository,
  type Database,
} from '@dankdash/db';
import {
  ApnsProvider,
  ResendEmailProvider,
  TwilioSmsProvider,
  type ApnsProviderConfig,
  type NotificationProvider,
  type ResendEmailsApi,
  type ResendProviderConfig,
  type TwilioMessagesApi,
  type TwilioSmsProviderConfig,
} from '@dankdash/notifications';
import { Module, type FactoryProvider, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Resend } from 'resend';
import twilio from 'twilio';
import { DRIZZLE_DB } from '../../infrastructure/drizzle.module.js';
import { REDIS_CLIENT } from '../../infrastructure/redis.module.js';
import { AuthModule } from '../auth/auth.module.js';
import {
  RedisNotificationDedupeStore,
  type NotificationDedupeStore,
} from './notification-dedupe.store.js';
import { NotificationDispatcher } from './notification-dispatcher.service.js';
import { NotificationPreferencesController } from './notification-preferences.controller.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import { NullNotificationProvider } from './null-notification.provider.js';
import { OrderNotificationsListener } from './order-notifications.listener.js';
import { PushTokensController } from './push-tokens.controller.js';
import { PushTokensService } from './push-tokens.service.js';
import { RefundNotificationsListener } from './refund-notifications.listener.js';
import { VendorOrderNotificationsListener } from './vendor-order-notifications.listener.js';

const PUSH_PROVIDER = Symbol.for('NOTIFICATIONS_PUSH_PROVIDER');
const SMS_PROVIDER = Symbol.for('NOTIFICATIONS_SMS_PROVIDER');
const EMAIL_PROVIDER = Symbol.for('NOTIFICATIONS_EMAIL_PROVIDER');
const NOTIFICATION_DEDUPE = Symbol.for('NOTIFICATIONS_DEDUPE');

const DEDUP_TTL_SECONDS = 24 * 60 * 60;

const pushTokensRepoProvider: FactoryProvider<PushTokensRepository> = {
  provide: PushTokensRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): PushTokensRepository => new PushTokensRepository(db),
};

const notificationsRepoProvider: FactoryProvider<NotificationsRepository> = {
  provide: NotificationsRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): NotificationsRepository => new NotificationsRepository(db),
};

const notificationPreferencesRepoProvider: FactoryProvider<NotificationPreferencesRepository> = {
  provide: NotificationPreferencesRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): NotificationPreferencesRepository =>
    new NotificationPreferencesRepository(db),
};

const usersRepoProvider: FactoryProvider<UsersRepository> = {
  provide: UsersRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): UsersRepository => new UsersRepository(db),
};

const dispensariesRepoProvider: FactoryProvider<DispensariesRepository> = {
  provide: DispensariesRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DispensariesRepository => new DispensariesRepository(db),
};

const dispensaryStaffRepoProvider: FactoryProvider<DispensaryStaffRepository> = {
  provide: DispensaryStaffRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DispensaryStaffRepository => new DispensaryStaffRepository(db),
};

const driversRepoProvider: FactoryProvider<DriversRepository> = {
  provide: DriversRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): DriversRepository => new DriversRepository(db),
};

const ordersRepoProvider: FactoryProvider<OrdersRepository> = {
  provide: OrdersRepository,
  inject: [DRIZZLE_DB],
  useFactory: (db: Database): OrdersRepository => new OrdersRepository(db),
};

const pushTokensServiceProvider: FactoryProvider<PushTokensService> = {
  provide: PushTokensService,
  inject: [PushTokensRepository],
  useFactory: (repo: PushTokensRepository): PushTokensService => new PushTokensService(repo),
};

const notificationPreferencesServiceProvider: FactoryProvider<NotificationPreferencesService> = {
  provide: NotificationPreferencesService,
  inject: [NotificationPreferencesRepository],
  useFactory: (repo: NotificationPreferencesRepository): NotificationPreferencesService =>
    new NotificationPreferencesService(repo),
};

const dedupeProvider: FactoryProvider<NotificationDedupeStore> = {
  provide: NOTIFICATION_DEDUPE,
  inject: [REDIS_CLIENT],
  useFactory: (redis: Redis): NotificationDedupeStore => new RedisNotificationDedupeStore(redis),
};

const pushProviderFactory: FactoryProvider<NotificationProvider> = {
  provide: PUSH_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): NotificationProvider => {
    const apnsConfig: ApnsProviderConfig = {
      keyId: config.getOrThrow<string>('APNS_KEY_ID'),
      teamId: config.getOrThrow<string>('APNS_TEAM_ID'),
      privateKey: Buffer.from(config.getOrThrow<string>('APNS_PRIVATE_KEY_BASE64'), 'base64'),
      production: config.getOrThrow<string>('NODE_ENV') === 'production',
    };
    return new ApnsProvider(apnsConfig);
  },
};

const smsProviderFactory: FactoryProvider<NotificationProvider> = {
  provide: SMS_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): NotificationProvider => {
    if (!config.getOrThrow<boolean>('ENABLE_TWILIO')) {
      return new NullNotificationProvider('sms', 'TWILIO');
    }
    const accountSid = config.getOrThrow<string>('TWILIO_ACCOUNT_SID');
    const authToken = config.getOrThrow<string>('TWILIO_AUTH_TOKEN');
    const client = twilio(accountSid, authToken);
    // Narrow the Twilio SDK surface to the messages.create() shape the
    // provider actually uses — keeps the type contract stable across
    // Twilio SDK majors and gives the provider a tight injection point.
    const messages: TwilioMessagesApi = {
      create: (params) =>
        client.messages.create({
          to: params.to,
          body: params.body,
          ...(params.from !== undefined ? { from: params.from } : {}),
          ...(params.messagingServiceSid !== undefined
            ? { messagingServiceSid: params.messagingServiceSid }
            : {}),
        }),
    };
    const messagingServiceSid = config.get<string | undefined>('TWILIO_MESSAGING_SERVICE_SID');
    const fromNumber = config.get<string | undefined>('TWILIO_FROM_NUMBER');
    const providerConfig: TwilioSmsProviderConfig = {
      messages,
      ...(messagingServiceSid !== undefined ? { messagingServiceSid } : {}),
      ...(fromNumber !== undefined ? { fromNumber } : {}),
    };
    return new TwilioSmsProvider(providerConfig);
  },
};

const emailProviderFactory: FactoryProvider<NotificationProvider> = {
  provide: EMAIL_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): NotificationProvider => {
    if (!config.getOrThrow<boolean>('ENABLE_RESEND')) {
      return new NullNotificationProvider('email', 'RESEND');
    }
    const apiKey = config.getOrThrow<string>('RESEND_API_KEY');
    const fromEmail = config.getOrThrow<string>('RESEND_FROM_EMAIL');
    const resend = new Resend(apiKey);
    const emails: ResendEmailsApi = {
      send: (payload) => resend.emails.send(payload),
    };
    const providerConfig: ResendProviderConfig = { emails, defaultFromEmail: fromEmail };
    return new ResendEmailProvider(providerConfig);
  },
};

const dispatcherProvider: FactoryProvider<NotificationDispatcher> = {
  provide: NotificationDispatcher,
  inject: [
    ConfigService,
    NOTIFICATION_DEDUPE,
    NotificationsRepository,
    NotificationPreferencesRepository,
    PushTokensRepository,
    UsersRepository,
    PUSH_PROVIDER,
    SMS_PROVIDER,
    EMAIL_PROVIDER,
  ],
  useFactory: (
    config: ConfigService,
    dedupe: NotificationDedupeStore,
    notifications: NotificationsRepository,
    notificationPreferences: NotificationPreferencesRepository,
    pushTokens: PushTokensRepository,
    users: UsersRepository,
    pushProvider: NotificationProvider,
    smsProvider: NotificationProvider,
    emailProvider: NotificationProvider,
  ): NotificationDispatcher =>
    new NotificationDispatcher({
      config: {
        apnsBundleIdByAppVariant: {
          consumer: config.getOrThrow<string>('APNS_BUNDLE_ID'),
          driver: config.getOrThrow<string>('APNS_BUNDLE_ID'),
        },
        dedupeTtlSeconds: DEDUP_TTL_SECONDS,
      },
      dedupe,
      notifications,
      notificationPreferences,
      pushTokens,
      users,
      pushProvider,
      smsProvider,
      emailProvider,
    }),
};

const orderListenerProvider: FactoryProvider<OrderNotificationsListener> = {
  provide: OrderNotificationsListener,
  inject: [
    NotificationDispatcher,
    OrdersRepository,
    DispensariesRepository,
    DriversRepository,
    UsersRepository,
  ],
  useFactory: (
    dispatcher: NotificationDispatcher,
    orders: OrdersRepository,
    dispensaries: DispensariesRepository,
    drivers: DriversRepository,
    users: UsersRepository,
  ): OrderNotificationsListener =>
    new OrderNotificationsListener({ dispatcher, orders, dispensaries, drivers, users }),
};

const refundListenerProvider: FactoryProvider<RefundNotificationsListener> = {
  provide: RefundNotificationsListener,
  inject: [NotificationDispatcher],
  useFactory: (dispatcher: NotificationDispatcher): RefundNotificationsListener =>
    new RefundNotificationsListener({ dispatcher }),
};

const vendorOrderListenerProvider: FactoryProvider<VendorOrderNotificationsListener> = {
  provide: VendorOrderNotificationsListener,
  inject: [NotificationDispatcher, DispensariesRepository, DispensaryStaffRepository],
  useFactory: (
    dispatcher: NotificationDispatcher,
    dispensaries: DispensariesRepository,
    staff: DispensaryStaffRepository,
  ): VendorOrderNotificationsListener =>
    new VendorOrderNotificationsListener({ dispatcher, dispensaries, staff }),
};

const providers: Provider[] = [
  pushTokensRepoProvider,
  notificationsRepoProvider,
  notificationPreferencesRepoProvider,
  usersRepoProvider,
  dispensariesRepoProvider,
  dispensaryStaffRepoProvider,
  driversRepoProvider,
  ordersRepoProvider,
  pushTokensServiceProvider,
  notificationPreferencesServiceProvider,
  dedupeProvider,
  pushProviderFactory,
  smsProviderFactory,
  emailProviderFactory,
  dispatcherProvider,
  orderListenerProvider,
  refundListenerProvider,
  vendorOrderListenerProvider,
];

@Module({
  imports: [AuthModule],
  controllers: [PushTokensController, NotificationPreferencesController],
  providers,
  exports: [PushTokensService, NotificationPreferencesService, NotificationDispatcher],
})
export class NotificationsModule {}
