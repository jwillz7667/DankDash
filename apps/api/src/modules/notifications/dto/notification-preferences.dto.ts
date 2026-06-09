/**
 * /v1/me/notification-preferences DTOs.
 *
 *   GET   /v1/me/notification-preferences  — returns the caller's effective
 *                                            preferences. A user who never
 *                                            saved any gets the all-on
 *                                            defaults (the service synthesizes
 *                                            them; no row is created on read).
 *   PATCH /v1/me/notification-preferences  — partial update; any subset of the
 *                                            five toggles. Upserts the single
 *                                            per-user row.
 *
 * Two axes, matching `notification_preferences` and the pure policy in
 * @dankdash/notifications:
 *   • category — `orderUpdates`, `promotions`. The only user-suppressible
 *     categories; transactional/operational notifications ignore this table.
 *   • channel  — `push`, `sms`, `email`. `in_app` has no toggle (it is the
 *     in-app inbox record and is always written).
 *
 * Suppression is the AND of the two axes: a delivery is dropped when its
 * category is off OR its channel is off. The client surfaces that as two
 * groups of switches.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const NotificationPreferencesResponseSchema = z
  .object({
    orderUpdatesEnabled: z.boolean(),
    promotionsEnabled: z.boolean(),
    pushEnabled: z.boolean(),
    smsEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type NotificationPreferencesResponse = z.infer<typeof NotificationPreferencesResponseSchema>;

/**
 * Partial update. `.partial()` makes every toggle optional; the refine
 * rejects an empty body so a no-op PATCH is a 422 rather than a silent
 * upsert that just bumps `updated_at`. `.strict()` rejects unknown keys
 * (e.g. an `inAppEnabled` a client might assume exists) up front.
 */
export const UpdateNotificationPreferencesRequestSchema = z
  .object({
    orderUpdatesEnabled: z.boolean(),
    promotionsEnabled: z.boolean(),
    pushEnabled: z.boolean(),
    smsEnabled: z.boolean(),
    emailEnabled: z.boolean(),
  })
  .strict()
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'at least one preference must be provided',
  });
export type UpdateNotificationPreferencesRequest = z.infer<
  typeof UpdateNotificationPreferencesRequestSchema
>;
export class UpdateNotificationPreferencesRequestDto extends createZodDto(
  UpdateNotificationPreferencesRequestSchema,
) {}
