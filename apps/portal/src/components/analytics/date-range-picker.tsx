'use client';

/**
 * Date-range picker for the analytics surface. URL-driven — writes
 * `?from=&to=` query params so the server components on /analytics/sales
 * and /analytics/products re-fetch with the new window on every change.
 *
 * Storing the range in the URL (rather than React state or cookies)
 * means tabbing between Sales and Products keeps the same window, deep
 * links work, and the back button rewinds the range as you'd expect.
 *
 * Presets snap to UTC midnights — analytics buckets use America/Chicago
 * for hour-of-day heatmaps but window endpoints are kept in UTC so URLs
 * are stable across DST transitions. Today/7/30/90 use a half-open
 * range: `to` is *tomorrow* 00:00 UTC so today's deliveries are
 * included.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export interface DateRangePickerProps {
  /**
   * Source of "now" for the preset math. Defaults to `new Date()` at
   * render time. Test seam — keeps the snapshot deterministic.
   */
  readonly nowFactory?: () => Date;
}

interface Preset {
  readonly key: string;
  readonly label: string;
  /** Days inclusive of today — "7" means today + 6 prior days. */
  readonly days: number;
}

const PRESETS: ReadonlyArray<Preset> = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
];

const DEFAULT_PRESET_KEY = '7d';

/**
 * Compute the half-open `[from, to)` UTC window for a preset. `to` is
 * tomorrow's UTC midnight so the bucket for "today so far" lands in the
 * window — vendors expect to see partial-day numbers without having to
 * pick a custom range.
 */
function presetWindow(days: number, now: Date): { from: string; to: string } {
  const toMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  const fromMs = toMs - days * 24 * 60 * 60 * 1000;
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

export function DateRangePicker({ nowFactory }: DateRangePickerProps): ReactNode {
  const router = useRouter();
  const searchParams = useSearchParams();
  const now = useMemo(() => nowFactory?.() ?? new Date(), [nowFactory]);

  const currentFrom = searchParams.get('from');
  const currentTo = searchParams.get('to');

  const activeKey = useMemo<string>(() => {
    if (currentFrom === null || currentTo === null) return DEFAULT_PRESET_KEY;
    for (const preset of PRESETS) {
      const { from, to } = presetWindow(preset.days, now);
      if (from === currentFrom && to === currentTo) return preset.key;
    }
    return 'custom';
  }, [currentFrom, currentTo, now]);

  const applyPreset = (preset: Preset): void => {
    const { from, to } = presetWindow(preset.days, now);
    const next = new URLSearchParams(searchParams.toString());
    next.set('from', from);
    next.set('to', to);
    router.push(`?${next.toString()}`, { scroll: false });
  };

  return (
    <div
      role="group"
      aria-label="Date range"
      className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm"
    >
      {PRESETS.map((preset) => {
        const active = activeKey === preset.key;
        return (
          <button
            key={preset.key}
            type="button"
            onClick={() => {
              applyPreset(preset);
            }}
            aria-pressed={active}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss-500 focus-visible:ring-offset-1',
              active
                ? 'bg-moss-50 text-moss-800'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
            )}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Server-component helper — resolves the window from the page's
 * `searchParams`. Falls back to the default preset (last 7 days)
 * when the URL is bare, so the first visit doesn't redirect or
 * 400 the API.
 */
export function resolveWindowFromSearchParams(
  searchParams: { readonly from?: string | string[]; readonly to?: string | string[] },
  now: Date = new Date(),
): { from: string; to: string } {
  const fromParam = typeof searchParams.from === 'string' ? searchParams.from : undefined;
  const toParam = typeof searchParams.to === 'string' ? searchParams.to : undefined;
  if (fromParam !== undefined && toParam !== undefined && isIsoZ(fromParam) && isIsoZ(toParam)) {
    return { from: fromParam, to: toParam };
  }
  return presetWindow(7, now);
}

function isIsoZ(value: string): boolean {
  // Accept any ISO-8601 with a Z or numeric offset. We only parse the
  // surface; the API re-validates and 400s on garbage.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value);
}
