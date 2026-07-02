import { Clock, PauseCircle, PlayCircle } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode } from 'react';
import { type VendorSettings } from '../../lib/api/vendor-settings.js';
import {
  dayHoursForNow,
  formatDayHoursLabel,
  isStoreOpenNow,
} from '../../lib/dashboard/dashboard.js';
import { Badge } from '../ui/badge.js';
import { Card, CardBody, CardHeader, CardSubtitle, CardTitle } from '../ui/card.js';

export interface StoreStatusCardProps {
  readonly settings: VendorSettings;
  /** Shared "now" so the open/closed check matches the rest of the page. */
  readonly now: Date;
}

/**
 * Store-status card (manager+ only — sourced from `/v1/vendor/settings`).
 * Answers the two questions an owner opens the dashboard to check: are
 * we open right now, and are we taking orders. "Open now" is derived
 * from the configured hours in the store's local timezone; "accepting
 * orders" is the operator's manual toggle, which can pause intake even
 * during posted hours.
 */
export function StoreStatusCard({ settings, now }: StoreStatusCardProps): ReactNode {
  const openNow = isStoreOpenNow(settings.hours, now);
  const todayHours = formatDayHoursLabel(dayHoursForNow(settings.hours, now));
  const accepting = settings.isAcceptingOrders;

  return (
    <Card data-testid="store-status-card">
      <CardHeader>
        <div className="space-y-0.5">
          <CardTitle>Store status</CardTitle>
          <CardSubtitle>Live open state and order intake.</CardSubtitle>
        </div>
        <Badge tone={openNow ? 'accent' : 'neutral'} data-testid="store-open-badge">
          {openNow ? 'Open now' : 'Closed'}
        </Badge>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={
              accepting
                ? 'mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-moss-50 text-moss-700'
                : 'mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-warning-soft text-warning'
            }
          >
            {accepting ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
          </span>
          <div className="flex-1 space-y-0.5">
            <p className="text-sm font-medium text-foreground" data-testid="store-accepting">
              {accepting ? 'Accepting orders' : 'Order intake paused'}
            </p>
            <p className="text-xs text-muted">
              {accepting
                ? 'Customers can check out for delivery right now.'
                : 'Resume intake from store settings when you are ready.'}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-surface-subtle text-muted"
          >
            <Clock className="h-4 w-4" />
          </span>
          <div className="flex-1 space-y-0.5">
            <p className="text-sm font-medium text-foreground">Today's hours</p>
            <p className="font-tabular text-xs text-muted" data-testid="store-hours">
              {todayHours}
            </p>
          </div>
        </div>

        <Link
          href="/settings/store"
          className="inline-flex text-xs font-medium text-moss-700 hover:text-moss-800"
        >
          Manage store settings
        </Link>
      </CardBody>
    </Card>
  );
}
