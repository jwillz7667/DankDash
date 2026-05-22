/**
 * Hourly heatmap — 7×24 grid showing order volume by day-of-week and
 * local hour (America/Chicago). Server-renderable; no client JS needed
 * because the cells don't open tooltips on hover — the title attribute
 * carries the full breakdown for the operator who needs detail.
 *
 * The grid reads like a calendar: rows = day of week (Sun..Sat), cols =
 * hours 0..23. The intensity is keyed to order count, not revenue, so a
 * spike of cheap items doesn't get drowned by one heavy basket.
 */
import { type ReactNode } from 'react';
import {
  dayOfWeekLabel,
  formatMoney,
  heatmapClass,
  hourLabel,
} from '../../lib/analytics/format.js';
import { type HourlyBucket } from '../../lib/api/vendor-analytics.js';
import { cn } from '../../lib/cn.js';

export interface HourlyHeatmapProps {
  readonly buckets: readonly HourlyBucket[];
}

interface Cell {
  readonly dayOfWeek: number;
  readonly hour: number;
  readonly orderCount: number;
  readonly revenueCents: number;
  readonly normalized: number | null;
}

const DAYS = 7;
const HOURS = 24;

function buildCells(buckets: readonly HourlyBucket[]): readonly Cell[] {
  const lookup = new Map<string, HourlyBucket>();
  for (const bucket of buckets) {
    lookup.set(`${bucket.dayOfWeek.toString()}:${bucket.hour.toString()}`, bucket);
  }
  let maxOrders = 0;
  for (const b of buckets) {
    if (b.orderCount > maxOrders) maxOrders = b.orderCount;
  }
  const cells: Cell[] = [];
  for (let dow = 0; dow < DAYS; dow += 1) {
    for (let hour = 0; hour < HOURS; hour += 1) {
      const bucket = lookup.get(`${dow.toString()}:${hour.toString()}`);
      const orderCount = bucket?.orderCount ?? 0;
      cells.push({
        dayOfWeek: dow,
        hour,
        orderCount,
        revenueCents: bucket?.revenueCents ?? 0,
        normalized: maxOrders === 0 ? null : orderCount === 0 ? 0 : orderCount / maxOrders,
      });
    }
  }
  return cells;
}

export function HourlyHeatmap({ buckets }: HourlyHeatmapProps): ReactNode {
  const cells = buildCells(buckets);
  const anyOrders = cells.some((c) => c.orderCount > 0);

  if (!anyOrders) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
        No orders in this window.
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label="Orders by hour and day of week heatmap"
      className="flex flex-col gap-1.5 overflow-x-auto"
      data-testid="hourly-heatmap"
    >
      <div className="flex items-center gap-1.5 pl-10 text-2xs font-medium uppercase tracking-wider text-slate-400">
        {Array.from({ length: HOURS }, (_, hour) => (
          <span
            key={hour}
            aria-hidden="true"
            className="w-6 shrink-0 text-center"
            title={hourLabel(hour)}
          >
            {hour % 3 === 0 ? hour.toString().padStart(2, '0') : ''}
          </span>
        ))}
      </div>
      {Array.from({ length: DAYS }, (_, dow) => (
        <div key={dow} className="flex items-center gap-1.5">
          <span className="w-9 shrink-0 pr-1 text-right text-2xs font-medium uppercase tracking-wider text-slate-500">
            {dayOfWeekLabel(dow)}
          </span>
          {cells
            .filter((c) => c.dayOfWeek === dow)
            .map((cell) => (
              <div
                key={`${cell.dayOfWeek.toString()}-${cell.hour.toString()}`}
                title={`${dayOfWeekLabel(cell.dayOfWeek)} ${hourLabel(cell.hour)} — ${cell.orderCount.toString()} orders, ${formatMoney(cell.revenueCents)}`}
                aria-label={`${dayOfWeekLabel(cell.dayOfWeek)} ${hourLabel(cell.hour)}: ${cell.orderCount.toString()} orders`}
                className={cn(
                  'h-5 w-6 shrink-0 rounded-sm text-center text-2xs font-medium leading-5',
                  heatmapClass(cell.normalized),
                )}
              >
                {cell.orderCount > 0 ? cell.orderCount.toString() : ''}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
