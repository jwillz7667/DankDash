/**
 * GET /v1/driver/earnings request + response schemas.
 *
 * The driver app picks one of three buckets ('today' | 'week' | 'month')
 * and the server computes the actual `[since, until)` half-open window
 * in America/Chicago. Bucket strings are stable identifiers — the iOS
 * `EarningsPeriod` enum mirrors them verbatim (see
 * `DankDashKit/Sources/DankDashDomain/EarningsPeriod.swift`), so adding
 * or renaming a bucket is a coordinated change across both layers.
 *
 * Money fields are integer cents. Timestamps are ISO-8601 with offset
 * (luxon's `toISO()` default); the client parses them with the same
 * `CatalogWire.parseISO8601` helper the rest of the app uses.
 *
 * Why server-computed bounds: the driver's device timezone may not be
 * America/Chicago (driver visiting Iowa, phone set to Pacific while on
 * vacation). Treating the bucket as a *server-derived window* avoids
 * the bug class where "Today" lights up an empty slice because the
 * client's day-rollover is hours off from the dispensary's local day.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const EarningsPeriodSchema = z.enum(['today', 'week', 'month']);
export type EarningsPeriod = z.infer<typeof EarningsPeriodSchema>;

export const DriverEarningsQuerySchema = z
  .object({
    period: EarningsPeriodSchema,
  })
  .strict();
export type DriverEarningsQuery = z.infer<typeof DriverEarningsQuerySchema>;

export class DriverEarningsQueryDto extends createZodDto(DriverEarningsQuerySchema) {}

export const DriverEarningsResponseSchema = z
  .object({
    period: EarningsPeriodSchema,
    since: z.string().datetime({ offset: true }),
    until: z.string().datetime({ offset: true }),
    tipsCents: z.number().int().nonnegative(),
    deliveryFeesCents: z.number().int().nonnegative(),
    deliveriesCount: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(),
  })
  .strict();

export type DriverEarningsResponse = z.infer<typeof DriverEarningsResponseSchema>;
