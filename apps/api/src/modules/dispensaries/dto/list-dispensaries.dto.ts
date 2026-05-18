/**
 * Query-string DTO for `GET /v1/dispensaries`.
 *
 * Both `lat` and `lng` are optional. If neither is provided, the endpoint
 * returns every active dispensary. If both are provided, the response is
 * filtered to dispensaries whose `delivery_polygon` contains the point
 * (PostGIS `ST_Contains`). Providing exactly one is a client bug — `.refine`
 * rejects it with 400 so a missing coordinate cannot silently disable the
 * geo filter.
 *
 * Coordinate bounds match WGS84 — latitudes in [-90, 90], longitudes in
 * [-180, 180]. Out-of-range values cannot satisfy `ST_Contains` against any
 * MN polygon, but rejecting them at the boundary keeps the SQL planner
 * from doing useless work and gives the client a clear error.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ListDispensariesQuerySchema = z
  .object({
    lat: z.coerce.number().gte(-90).lte(90).optional(),
    lng: z.coerce.number().gte(-180).lte(180).optional(),
  })
  .strict()
  .refine(
    (q) => (q.lat === undefined) === (q.lng === undefined),
    'lat and lng must be provided together',
  );

export type ListDispensariesQuery = z.infer<typeof ListDispensariesQuerySchema>;

export class ListDispensariesQueryDto extends createZodDto(ListDispensariesQuerySchema) {}
