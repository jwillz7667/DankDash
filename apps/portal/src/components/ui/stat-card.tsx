import { type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export type StatTrend = 'up' | 'down' | 'flat';

export interface StatCardProps {
  readonly label: string;
  readonly value: string;
  /**
   * Optional sub-label that sits under the big number — "vs last week",
   * "today", etc. Pair with `trend` for a directional indicator.
   */
  readonly delta?: string;
  readonly trend?: StatTrend;
  /**
   * Optional secondary value column (right-aligned). Used for "of N"
   * suffixes — "12 / 47 completed" — without forcing the consumer to
   * concatenate the strings.
   */
  readonly suffix?: string;
  /**
   * Optional Lucide icon. Renders in a soft moss square at the top-right.
   */
  readonly icon?: ReactNode;
  /**
   * Highlight state — pulls in the moss-tinted top bar on important
   * cards (e.g. "live orders" on the dashboard).
   */
  readonly highlight?: boolean;
  readonly className?: string;
}

const TREND_CLASSES: Record<StatTrend, string> = {
  up: 'text-moss-700',
  down: 'text-ember',
  flat: 'text-muted',
};

const TREND_GLYPH: Record<StatTrend, string> = {
  up: '▲',
  down: '▼',
  flat: '—',
};

/**
 * Stat / KPI card. Generous whitespace, tabular numerals so the value
 * never jitters as it updates in realtime.
 */
export function StatCard({
  label,
  value,
  delta,
  trend,
  suffix,
  icon,
  highlight = false,
  className,
}: StatCardProps): ReactNode {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border border-outline bg-surface p-6 shadow-sm',
        'transition-shadow duration-200 ease-out hover:shadow-md',
        className,
      )}
    >
      {highlight ? (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-moss-500 via-moss-400 to-moss-500"
        />
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
        {icon !== undefined ? (
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-moss-50 text-moss-700">
            {icon}
          </span>
        ) : null}
      </div>
      <div className="mt-4 flex items-baseline gap-2 font-tabular">
        <span className="text-3xl font-semibold tracking-tight text-foreground">{value}</span>
        {suffix !== undefined ? (
          <span className="text-sm font-medium text-muted">{suffix}</span>
        ) : null}
      </div>
      {(delta !== undefined || trend !== undefined) && (
        <div className="mt-2 flex items-center gap-1.5 text-xs font-medium">
          {trend !== undefined ? (
            <span className={cn('font-tabular', TREND_CLASSES[trend])}>{TREND_GLYPH[trend]}</span>
          ) : null}
          {delta !== undefined ? <span className="text-muted">{delta}</span> : null}
        </div>
      )}
    </div>
  );
}
