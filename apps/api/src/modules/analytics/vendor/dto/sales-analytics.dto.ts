/**
 * DTOs for the vendor-portal sales analytics surface.
 *
 *   GET /v1/vendor/analytics/sales?from=ISO&to=ISO
 *
 * The window is half-open: `from` inclusive, `to` exclusive. The same
 * window length is shifted back by its own duration to compute the
 * previous-period comparison (`previousRevenueCents` et al). Vendor
 * portal renders deltas client-side so the API only needs to ship both
 * numbers.
 *
 * `hourly` is a 24-bucket × 7-day-of-week heatmap of order counts in the
 * local timezone of the dispensary (America/Chicago — every dispensary
 * is in MN per the spec). Buckets the portal can render as a `heatmap`
 * without a second round-trip.
 *
 * `topProducts` is the head of the product distribution sorted by
 * revenueCents desc. The portal renders a list, not a chart, so a small
 * limit is enough — five rows is the spec target.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Query-string carrier. Both fields are required ISO-8601 timestamps —
 * the portal computes them from the date-range picker. Refusing
 * open-ended windows up front keeps the SQL bounded and avoids "select
 * all delivered orders ever" accidents in dev.
 *
 * `to > from` is enforced; the maximum window is 366 days so a vendor
 * can pull a full year for an annual report but cannot accidentally
 * scan an unbounded range.
 */
export const SalesAnalyticsQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((q) => Date.parse(q.to) > Date.parse(q.from), {
    message: 'to must be strictly greater than from',
    path: ['to'],
  })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 24 * 60 * 60 * 1000, {
    message: 'Window must be at most 366 days',
    path: ['to'],
  });
export type SalesAnalyticsQuery = z.infer<typeof SalesAnalyticsQuerySchema>;
export class SalesAnalyticsQueryDto extends createZodDto(SalesAnalyticsQuerySchema) {}

export const HourlyBucketSchema = z
  .object({
    /** ISO weekday, 0 = Sunday … 6 = Saturday. Matches JS `Date.getUTCDay`. */
    dayOfWeek: z.number().int().min(0).max(6),
    /** Local hour, 0..23. */
    hour: z.number().int().min(0).max(23),
    orderCount: z.number().int().min(0),
    revenueCents: z.number().int().min(0),
  })
  .strict();
export type HourlyBucket = z.infer<typeof HourlyBucketSchema>;

export const TopProductSchema = z
  .object({
    productId: z.string().uuid(),
    brand: z.string(),
    name: z.string(),
    unitsSold: z.number().int().min(0),
    revenueCents: z.number().int().min(0),
  })
  .strict();
export type TopProduct = z.infer<typeof TopProductSchema>;

export const SalesAnalyticsResponseSchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    /** Sum of `totalCents` over delivered orders inside [from, to). */
    revenueCents: z.number().int().min(0),
    /**
     * Same aggregation against the prior window of equal length ending at
     * `from`. Portal renders the delta as a percentage; we ship both raw
     * values so a near-zero divisor lands as "—" instead of `Infinity%`.
     */
    previousRevenueCents: z.number().int().min(0),
    orderCount: z.number().int().min(0),
    previousOrderCount: z.number().int().min(0),
    /** Integer cents. Zero when `orderCount === 0`. */
    avgOrderValueCents: z.number().int().min(0),
    previousAvgOrderValueCents: z.number().int().min(0),
    hourly: z.array(HourlyBucketSchema).readonly(),
    topProducts: z.array(TopProductSchema).readonly(),
  })
  .strict();
export type SalesAnalyticsResponse = z.infer<typeof SalesAnalyticsResponseSchema>;
export class SalesAnalyticsResponseDto extends createZodDto(SalesAnalyticsResponseSchema) {}
