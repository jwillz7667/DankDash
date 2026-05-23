/**
 * License info — read-only on this surface. The MN cannabis license
 * number, type, and expiry are governed by the compliance team; edits
 * happen out-of-band via the review path (Phase 19). What this card
 * gives the operator is *visibility* — especially the expiry warning
 * inside the 90-day window the spec calls out.
 */
import { AlertTriangle, FileBadge2 } from 'lucide-react';
import { type ReactNode } from 'react';
import {
  formatCalendarDate,
  licenseExpiryStatus,
  licenseTypeLabel,
  type ExpiryStatus,
} from '../../lib/settings/format.js';
import { Badge, type BadgeTone } from '../ui/badge.js';
import { Card, CardBody, CardHeader, CardSubtitle, CardTitle } from '../ui/card.js';
import type { LicenseType } from '../../lib/api/vendor-settings.js';

export interface LicenseCardProps {
  readonly licenseNumber: string;
  readonly licenseType: LicenseType;
  readonly licenseIssuedAt: string;
  readonly licenseExpiresAt: string;
  /** Override for testing. Defaults to `new Date()`. */
  readonly now?: Date;
}

const STATUS_TONE: Record<ExpiryStatus, BadgeTone> = {
  expired: 'danger',
  critical: 'danger',
  warn: 'warning',
  ok: 'accent',
};

function statusCopy(status: ExpiryStatus, daysRemaining: number): string {
  if (status === 'expired') return `Expired ${Math.abs(daysRemaining)} d ago`;
  if (status === 'critical') return `Expires in ${daysRemaining} d`;
  if (status === 'warn') return `Expires in ${daysRemaining} d`;
  return 'Current';
}

export function LicenseCard({
  licenseNumber,
  licenseType,
  licenseIssuedAt,
  licenseExpiresAt,
  now,
}: LicenseCardProps): ReactNode {
  const { status, daysRemaining } = licenseExpiryStatus(licenseExpiresAt, now);
  const showWarningBanner = status === 'expired' || status === 'critical' || status === 'warn';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-moss-50 text-moss-700">
            <FileBadge2 aria-hidden="true" className="h-4 w-4" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <CardTitle>MN cannabis license</CardTitle>
              <Badge tone={STATUS_TONE[status]} data-testid="license-status">
                {statusCopy(status, daysRemaining)}
              </Badge>
            </div>
            <CardSubtitle>
              Issued by the Minnesota Office of Cannabis Management. Changes go through compliance
              review.
            </CardSubtitle>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {showWarningBanner ? (
          <div
            role="alert"
            className={
              status === 'warn'
                ? 'flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning'
                : 'flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger'
            }
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none" />
            <p>
              {status === 'expired'
                ? "This license has expired. Orders are blocked at checkout until it's renewed."
                : status === 'critical'
                  ? "Renewal is overdue or imminent — DankDash will suspend intake on the expiry date if it isn't renewed."
                  : 'Renewal window has opened. Submit the renewal packet to the OCM at least 30 days before expiry.'}
            </p>
          </div>
        ) : null}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field label="License type" value={licenseTypeLabel(licenseType)} />
          <Field label="License number" value={licenseNumber} mono />
          <Field label="Issued" value={formatCalendarDate(licenseIssuedAt)} />
          <Field label="Expires" value={formatCalendarDate(licenseExpiresAt)} />
        </dl>
      </CardBody>
    </Card>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): ReactNode {
  return (
    <div className="space-y-0.5">
      <dt className="text-2xs font-medium uppercase tracking-wider text-muted">{label}</dt>
      <dd
        className={
          mono
            ? 'text-sm font-medium text-foreground font-mono tracking-tight'
            : 'text-sm font-medium text-foreground'
        }
      >
        {value}
      </dd>
    </div>
  );
}
