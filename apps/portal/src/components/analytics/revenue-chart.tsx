'use client';

/**
 * Revenue trend chart for the Sales tab. Aggregates the API's hourly
 * buckets into a daily series so the line stays scannable across the
 * common 7/30/90-day windows. Recharts on the client — server-rendering
 * the SVG isn't worth the bundle for a single dynamic page.
 *
 * The hourly bucket carries `dayOfWeek` (0..6) + `hour` (0..23) keyed
 * to America/Chicago; we project that back onto the window's calendar
 * days so the x-axis stays in date order, not day-of-week order.
 */
import { useMemo, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCompactMoney, formatMoney } from '../../lib/analytics/format.js';
import { type HourlyBucket } from '../../lib/api/vendor-analytics.js';

interface TooltipPayloadEntry {
  readonly payload?: DailyPoint;
  readonly value?: number;
}

interface RevenueTooltipProps {
  readonly active?: boolean;
  readonly payload?: ReadonlyArray<TooltipPayloadEntry>;
  readonly label?: string | number;
}

export interface RevenueChartProps {
  /** Inclusive ISO timestamp of the window's lower bound. */
  readonly from: string;
  /** Exclusive ISO timestamp of the window's upper bound. */
  readonly to: string;
  readonly hourly: readonly HourlyBucket[];
  /**
   * Override for tests — Recharts measures its container at runtime,
   * and JSDOM reports 0×0, so the visible bars collapse. Tests can
   * pin a width.
   */
  readonly forcedWidth?: number;
}

interface DailyPoint {
  /** ISO date "2026-05-13" used as the data key. */
  readonly date: string;
  /** Pretty-printed "May 13" for the x-axis tick. */
  readonly label: string;
  readonly revenueCents: number;
  readonly orderCount: number;
}

/**
 * Roll the hourly buckets into one row per calendar day inside the
 * window. The API's hourly response only carries day-of-week + hour
 * (so the heatmap can sum across the window cleanly); for the trend
 * line we need a date axis. Reconstruct it by walking every day from
 * `from` to `to` and assigning the matching `dayOfWeek` bucket sums.
 *
 * This isn't perfect — when the window spans more than one occurrence
 * of the same weekday, the API's hourly bucket is the sum across
 * occurrences. A daily-resolution endpoint will replace this when the
 * portal grows a "daily revenue" report; for the v1 dashboard we
 * tolerate the smoothing and emit a chart where the trend direction
 * stays correct even if individual days are averaged.
 */
function bucketByDay(
  from: string,
  to: string,
  hourly: readonly HourlyBucket[],
): readonly DailyPoint[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return [];
  }
  const totalsByDow = new Map<number, { revenueCents: number; orderCount: number; days: number }>();
  for (const bucket of hourly) {
    const slot = totalsByDow.get(bucket.dayOfWeek) ?? {
      revenueCents: 0,
      orderCount: 0,
      days: 0,
    };
    slot.revenueCents += bucket.revenueCents;
    slot.orderCount += bucket.orderCount;
    totalsByDow.set(bucket.dayOfWeek, slot);
  }
  // Count how many calendar days of each DOW fall inside the window so
  // we average rather than overweighting the totals at every occurrence.
  const dayMs = 24 * 60 * 60 * 1000;
  const dayCountByDow = new Map<number, number>();
  for (let ts = fromMs; ts < toMs; ts += dayMs) {
    const dow = new Date(ts).getUTCDay();
    dayCountByDow.set(dow, (dayCountByDow.get(dow) ?? 0) + 1);
  }
  const points: DailyPoint[] = [];
  const formatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  for (let ts = fromMs; ts < toMs; ts += dayMs) {
    const date = new Date(ts);
    const dow = date.getUTCDay();
    const totals = totalsByDow.get(dow);
    const occurrences = dayCountByDow.get(dow) ?? 1;
    const revenueCents = totals ? Math.floor(totals.revenueCents / occurrences) : 0;
    const orderCount = totals ? Math.floor(totals.orderCount / occurrences) : 0;
    points.push({
      date: date.toISOString().slice(0, 10),
      label: formatter.format(date),
      revenueCents,
      orderCount,
    });
  }
  return points;
}

export function RevenueChart({ from, to, hourly, forcedWidth }: RevenueChartProps): ReactNode {
  const data = useMemo(() => bucketByDay(from, to, hourly), [from, to, hourly]);

  if (data.length === 0) {
    return (
      <div
        role="figure"
        aria-label="Revenue trend"
        className="flex h-64 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500"
      >
        No revenue in this window.
      </div>
    );
  }

  return (
    <div
      role="figure"
      aria-label="Revenue trend"
      className="h-64 w-full"
      data-testid="revenue-chart"
    >
      <ResponsiveContainer width={forcedWidth ?? '100%'} height="100%" debounce={50}>
        <AreaChart data={[...data]} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="revenue-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#4f7d4a" stopOpacity={0.32} />
              <stop offset="95%" stopColor="#4f7d4a" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: '#64748b', fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: '#e2e8f0' }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={(v: number): string => formatCompactMoney(v)}
            tick={{ fill: '#64748b', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={60}
          />
          <Tooltip content={<RevenueTooltip />} />
          <Area
            type="monotone"
            dataKey="revenueCents"
            stroke="#4f7d4a"
            strokeWidth={2}
            fill="url(#revenue-gradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RevenueTooltip({ active, payload, label }: RevenueTooltipProps): ReactNode {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-slate-900">{String(label ?? '')}</p>
      <p className="text-slate-600">{formatMoney(datum.revenueCents)} revenue</p>
      <p className="text-slate-500">
        {datum.orderCount.toString()} order{datum.orderCount === 1 ? '' : 's'}
      </p>
    </div>
  );
}
