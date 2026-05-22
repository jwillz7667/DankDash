/**
 * Address + delivery polygon — read-only display. Addresses move
 * through compliance review (the polygon has to be re-validated for
 * statute compliance and out-of-state inclusion), so we render but
 * don't edit.
 */
import { MapPin, MapPinned } from 'lucide-react';
import { type ReactNode } from 'react';
import { Card, CardBody, CardHeader, CardSubtitle, CardTitle } from '../ui/card.js';
import type { GeoPoint, GeoPolygon } from '../../lib/api/vendor-settings.js';

export interface AddressCardProps {
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly location: GeoPoint;
  readonly deliveryPolygon: GeoPolygon;
}

export function AddressCard({
  addressLine1,
  addressLine2,
  city,
  region,
  postalCode,
  location,
  deliveryPolygon,
}: AddressCardProps): ReactNode {
  const [lon, lat] = location.coordinates;
  const polygonVertexCount =
    deliveryPolygon.coordinates[0] !== undefined
      ? Math.max(0, deliveryPolygon.coordinates[0].length - 1)
      : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-moss-50 text-moss-700">
            <MapPin aria-hidden="true" className="h-4 w-4" />
          </div>
          <div>
            <CardTitle>Address & delivery area</CardTitle>
            <CardSubtitle>
              Updates go through compliance — the polygon is re-validated against state-line and
              statute rules.
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <address className="text-sm not-italic text-slate-700">
          <div className="font-medium text-slate-900">{addressLine1}</div>
          {addressLine2 !== null ? <div>{addressLine2}</div> : null}
          <div>
            {city}, {region} {postalCode}
          </div>
        </address>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field
            label="Storefront coordinates"
            value={`${lat.toFixed(5)}, ${lon.toFixed(5)}`}
            mono
          />
          <Field
            label="Delivery polygon"
            value={`${polygonVertexCount} vertices`}
            icon={<MapPinned aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />}
          />
        </dl>

        <p className="text-xs text-slate-500">
          Interactive polygon editing ships in Phase 19. To request a change, contact your account
          manager with the new coverage boundary.
        </p>
      </CardBody>
    </Card>
  );
}

function Field({
  label,
  value,
  mono = false,
  icon,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly icon?: ReactNode;
}): ReactNode {
  return (
    <div className="space-y-0.5">
      <dt className="text-2xs font-medium uppercase tracking-wider text-slate-500">{label}</dt>
      <dd
        className={
          mono
            ? 'inline-flex items-center gap-1.5 text-sm font-medium text-slate-900 font-mono tracking-tight'
            : 'inline-flex items-center gap-1.5 text-sm font-medium text-slate-900'
        }
      >
        {icon}
        {value}
      </dd>
    </div>
  );
}
