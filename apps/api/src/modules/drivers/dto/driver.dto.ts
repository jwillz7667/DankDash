/**
 * Public read DTO for the drivers feature surface.
 *
 * Returned by the admin onboarding/patch endpoints and (in Phase 8.5) by
 * the driver-self `GET /v1/driver/me` endpoint. The shape excludes the
 * licence-number hash — clients have no use for an opaque bytea and the
 * less the hash circulates the smaller its blast radius if a response is
 * intercepted.
 *
 * Geo fields are GeoJSON Point at the wire level (`{ type: "Point",
 * coordinates: [lon, lat] }`); the same shape the dispensary feed uses.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { GeoPointSchema } from '../../dispensaries/dto/dispensary.dto.js';

export const DriverStatusSchema = z.enum([
  'offline',
  'online',
  'en_route_pickup',
  'en_route_dropoff',
  'on_break',
  'unavailable',
]);
export type DriverStatusDto = z.infer<typeof DriverStatusSchema>;

export const DriverResponseSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    vehicleMake: z.string().nullable(),
    vehicleModel: z.string().nullable(),
    vehicleYear: z.number().int().nullable(),
    vehiclePlate: z.string().nullable(),
    vehicleColor: z.string().nullable(),
    insuranceDocKey: z.string().nullable(),
    insuranceExpiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable(),
    backgroundCheckPassedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable(),
    backgroundCheckProviderRef: z.string().nullable(),
    currentStatus: DriverStatusSchema,
    lastStatusChangeAt: z.string().datetime({ offset: true }),
    currentLocation: GeoPointSchema.nullable(),
    currentLocationUpdatedAt: z.string().datetime({ offset: true }).nullable(),
    currentOrderId: z.string().uuid().nullable(),
    ratingAvg: z.string().nullable(),
    ratingCount: z.number().int().min(0),
    totalDeliveries: z.number().int().min(0),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type DriverResponse = z.infer<typeof DriverResponseSchema>;

export class DriverResponseDto extends createZodDto(DriverResponseSchema) {}
