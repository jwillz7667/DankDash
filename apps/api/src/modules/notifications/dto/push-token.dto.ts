/**
 * Push-token registration request + response shapes.
 *
 *   POST /v1/me/push-tokens
 *     body  → { deviceId, apnsToken, platform: 'ios', appVariant: 'consumer'|'driver' }
 *     201   → { pushToken: PushTokenResponse }
 *
 *   DELETE /v1/me/push-tokens/:id
 *     204   → no body
 *
 * `deviceId` is the IDFV (iOS identifierForVendor) — stable across
 * reinstalls of the same app on the same device, distinct across apps
 * and after a full vendor uninstall. The unique key on `push_tokens` is
 * `(user_id, device_id, app_variant)` so re-registering with the same
 * device/app simply rotates the APNs token in place rather than
 * orphaning the previous row. That matters because APNs tokens rotate
 * (iOS reissues on app restore, time zone shifts, etc.) and the dispatcher
 * would otherwise fan out to a dead token + a live token for the same
 * device.
 *
 * `apnsToken` is hex (lowercase) per Apple's convention. Length is 64
 * chars for the current ProductionAPNs encoding. Reject any other shape
 * up front — the APNs provider would fail loudly anyway, but rejecting
 * at the boundary keeps malformed tokens out of the table.
 *
 * `platform` is restricted to 'ios' in v1 — DankDash launches iOS-first
 * and the Apple-policy workaround (see spec §10.4) is iOS-specific.
 * Android support will widen the enum when it ships.
 *
 * `appVariant` distinguishes the consumer app from the driver app so the
 * dispatcher fans `dispatch.offer` only to driver-app tokens and
 * `order.accepted` only to consumer-app tokens. Vendor portal is web,
 * so no `'vendor'` variant.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const PushTokenPlatformSchema = z.enum(['ios']);
export type PushTokenPlatformDto = z.infer<typeof PushTokenPlatformSchema>;

export const PushTokenAppVariantSchema = z.enum(['consumer', 'driver']);
export type PushTokenAppVariantDto = z.infer<typeof PushTokenAppVariantSchema>;

export const RegisterPushTokenRequestSchema = z
  .object({
    deviceId: z.string().min(1).max(64),
    apnsToken: z
      .string()
      .length(64, 'apnsToken must be 64 hex chars')
      .regex(/^[0-9a-f]+$/u, 'apnsToken must be lowercase hex'),
    platform: PushTokenPlatformSchema,
    appVariant: PushTokenAppVariantSchema,
  })
  .strict();

export type RegisterPushTokenRequest = z.infer<typeof RegisterPushTokenRequestSchema>;

export class RegisterPushTokenRequestDto extends createZodDto(RegisterPushTokenRequestSchema) {}

export const PushTokenResponseSchema = z
  .object({
    id: z.string().uuid(),
    deviceId: z.string(),
    platform: PushTokenPlatformSchema,
    appVariant: PushTokenAppVariantSchema,
    isActive: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type PushTokenResponse = z.infer<typeof PushTokenResponseSchema>;

export const RegisterPushTokenResponseSchema = z
  .object({
    pushToken: PushTokenResponseSchema,
  })
  .strict();

export type RegisterPushTokenResponse = z.infer<typeof RegisterPushTokenResponseSchema>;
