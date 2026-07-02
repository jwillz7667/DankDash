/**
 * Pure domain logic for the vendor dashboard landing page. Every export
 * is a pure function or constant — no I/O, no React, no `Date.now()`
 * captured internally (callers inject `now` so the unit tests and the
 * server render agree on a single reference instant).
 *
 * The dashboard composes four existing vendor endpoints; this module
 * owns the derivations that sit between the wire shapes and the cards:
 *
 *   - the "today so far" analytics window, anchored to the store's
 *     America/Chicago calendar day (sales are keyed on `delivered_at`);
 *   - the local open/closed evaluation against `DispensaryHours`,
 *     including the 8 AM – 2 AM overnight window the compliance spec
 *     allows (close < open ⇒ the window spills past midnight);
 *   - the active-queue rollup and recent-activity ordering;
 *   - the last/next payout selection;
 *   - the order-status label + badge tone maps (kept exhaustive over
 *     `OrderStatus` so a new status breaks `tsc` here instead of
 *     rendering a blank badge).
 */
import type { BadgeTone } from '../../components/ui/badge.js';
import type { UserRole } from '../api/types.js';
import type { AnalyticsWindowQuery } from '../api/vendor-analytics.js';
import type { OrderStatus, VendorQueueOrderSummary } from '../api/vendor-orders.js';
import type { VendorPayoutSummary } from '../api/vendor-payouts.js';
import type { DayHours, DispensaryHours } from '../api/vendor-settings.js';

/** The single store timezone for v1 — all hour math renders against it. */
export const STORE_TIMEZONE = 'America/Chicago';

/**
 * Global roles allowed to read the store's financial + configuration
 * surfaces (`/v1/vendor/payouts`, `/v1/vendor/settings`). Mirrors the
 * API's `@Roles('manager','owner','admin','superadmin')` on those
 * controllers and the sidebar's `MANAGER_PLUS` nav gate — a budtender
 * would 403, so the dashboard skips those fetches entirely for them.
 */
const MANAGER_PLUS_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'manager',
  'owner',
  'admin',
  'superadmin',
]);

export function canViewStoreFinancials(role: UserRole): boolean {
  return MANAGER_PLUS_ROLES.has(role);
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = Number(part.value);
  }
  return {
    year: lookup['year'] ?? 0,
    month: lookup['month'] ?? 1,
    day: lookup['day'] ?? 1,
    hour: lookup['hour'] ?? 0,
    minute: lookup['minute'] ?? 0,
    second: lookup['second'] ?? 0,
  };
}

/**
 * UTC instant of the given wall-clock time in `timeZone`. Single-offset
 * correction: accurate for every instant except the ~1h DST-overlap
 * window, which start-of-day (00:00) and store hours (≥ 08:00) never
 * land in — CT transitions happen at 02:00.
 */
function wallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const seen = getZonedParts(new Date(guessMs), timeZone);
  const seenMs = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  return new Date(guessMs - (seenMs - guessMs));
}

/**
 * The "today so far" analytics window: `[start of the store's local day,
 * now)`. `from` is midnight America/Chicago rendered as a UTC ISO
 * instant; `to` is the current instant. The vendor-analytics service
 * derives the prior-period baseline (an equal-length window ending at
 * `from`) on its own, so a single call yields both today and the delta.
 */
export function resolveTodayWindow(now: Date): AnalyticsWindowQuery {
  const { year, month, day } = getZonedParts(now, STORE_TIMEZONE);
  const startOfDay = wallTimeToUtc(year, month, day, 0, 0, STORE_TIMEZONE);
  return { from: startOfDay.toISOString(), to: now.toISOString() };
}

export function greetingFor(now: Date): string {
  const { hour } = getZonedParts(now, STORE_TIMEZONE);
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export interface ActiveOrdersSummary {
  /** Every order currently on the vendor queue surface. */
  readonly total: number;
  /** `placed` — waiting for the store to accept or reject. */
  readonly awaitingAccept: number;
  /** `accepted` + `prepping` — staff is assembling the bag. */
  readonly inPrep: number;
  /** Ready / dispatching / driver-at-counter — waiting on the driver. */
  readonly readyForHandoff: number;
}

const AWAITING_ACCEPT: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['placed']);
const IN_PREP: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['accepted', 'prepping']);
const READY_FOR_HANDOFF: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'ready_for_pickup',
  'awaiting_driver',
  'driver_assigned',
  'en_route_pickup',
]);

export function summarizeActiveOrders(
  orders: readonly VendorQueueOrderSummary[],
): ActiveOrdersSummary {
  let awaitingAccept = 0;
  let inPrep = 0;
  let readyForHandoff = 0;
  for (const order of orders) {
    if (AWAITING_ACCEPT.has(order.status)) awaitingAccept += 1;
    else if (IN_PREP.has(order.status)) inPrep += 1;
    else if (READY_FOR_HANDOFF.has(order.status)) readyForHandoff += 1;
  }
  return { total: orders.length, awaitingAccept, inPrep, readyForHandoff };
}

/**
 * Newest-first slice of the active queue for the recent-activity rail.
 * The queue endpoint returns oldest-first (so the longest-waiting order
 * floats to the top of each kanban column); the dashboard wants the
 * opposite — the most recent movement first — so we re-sort by
 * `statusChangedAt` descending and cap at `limit`.
 */
export function selectRecentActivity(
  orders: readonly VendorQueueOrderSummary[],
  limit: number,
): readonly VendorQueueOrderSummary[] {
  return [...orders]
    .sort((a, b) => Date.parse(b.statusChangedAt) - Date.parse(a.statusChangedAt))
    .slice(0, limit);
}

export interface PayoutSnapshot {
  /** Most recently disbursed payout, or null if none has completed. */
  readonly last: VendorPayoutSummary | null;
  /** Soonest upcoming payout (pending/processing), or null if none. */
  readonly next: VendorPayoutSummary | null;
}

const UPCOMING_PAYOUT_STATUSES: ReadonlySet<VendorPayoutSummary['status']> = new Set([
  'pending',
  'processing',
]);

/**
 * Split the payout list into "last paid" and "next scheduled". The list
 * arrives newest-first (by `created_at`); we pick the first completed
 * row as `last`, and among the upcoming rows the one with the soonest
 * `scheduledFor` as `next`.
 */
export function selectPayoutSnapshot(payouts: readonly VendorPayoutSummary[]): PayoutSnapshot {
  const last = payouts.find((p) => p.status === 'completed') ?? null;

  let next: VendorPayoutSummary | null = null;
  for (const payout of payouts) {
    if (!UPCOMING_PAYOUT_STATUSES.has(payout.status)) continue;
    if (next === null || payout.scheduledFor < next.scheduledFor) {
      next = payout;
    }
  }
  return { last, next };
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DayKey = (typeof DAY_KEYS)[number];

function weekdayKey(now: Date): DayKey {
  const { year, month, day } = getZonedParts(now, STORE_TIMEZONE);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return DAY_KEYS[dow] ?? 'sun';
}

function previousDayKey(key: DayKey): DayKey {
  const index = DAY_KEYS.indexOf(key);
  return DAY_KEYS[(index + 6) % 7] ?? 'sun';
}

function minutesOfDay(now: Date): number {
  const { hour, minute } = getZonedParts(now, STORE_TIMEZONE);
  return hour * 60 + minute;
}

/** "HH:MM" → minutes since midnight, or null if malformed. */
function parseClockMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/** True when the day's window closes on the following calendar day. */
function isOvernight(day: DayHours): boolean {
  const open = parseClockMinutes(day.open);
  const close = parseClockMinutes(day.close);
  if (open === null || close === null) return false;
  return close < open;
}

/** The store hours for the local calendar day `now` falls on. */
export function dayHoursForNow(hours: DispensaryHours, now: Date): DayHours | null {
  return hours[weekdayKey(now)];
}

/**
 * Whether the store is open at `now`, honoring overnight windows. A
 * `close < open` day (e.g. 08:00 → 02:00) is open from `open` until
 * midnight, and the early-morning tail (midnight → `close`) is
 * attributed to the *previous* calendar day's row.
 */
export function isStoreOpenNow(hours: DispensaryHours, now: Date): boolean {
  const minutes = minutesOfDay(now);
  const todayKey = weekdayKey(now);

  const today = hours[todayKey];
  if (today !== null && withinDayWindow(today, minutes)) return true;

  const yesterday = hours[previousDayKey(todayKey)];
  if (yesterday !== null && isOvernight(yesterday)) {
    const close = parseClockMinutes(yesterday.close);
    if (close !== null && minutes < close) return true;
  }
  return false;
}

function withinDayWindow(day: DayHours, minutes: number): boolean {
  const open = parseClockMinutes(day.open);
  const close = parseClockMinutes(day.close);
  if (open === null || close === null || open === close) return false;
  if (close > open) return minutes >= open && minutes < close;
  // Overnight: open until midnight on this calendar day.
  return minutes >= open;
}

/** "08:00" → "8:00 AM". Returns the raw value if it can't be parsed. */
export function formatClock(value: string): string {
  const total = parseClockMinutes(value);
  if (total === null) return value;
  const hours24 = Math.floor(total / 60);
  const mins = total % 60;
  const period = hours24 < 12 ? 'AM' : 'PM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12.toString()}:${mins.toString().padStart(2, '0')} ${period}`;
}

/** "8:00 AM – 2:00 AM" for the day, or "Closed" when the row is null. */
export function formatDayHoursLabel(day: DayHours | null): string {
  if (day === null) return 'Closed';
  return `${formatClock(day.open)} – ${formatClock(day.close)}`;
}

const ORDER_STATUS_LABEL: Readonly<Record<OrderStatus, string>> = {
  placed: 'New order',
  payment_failed: 'Payment failed',
  accepted: 'Accepted',
  rejected: 'Rejected',
  prepping: 'Prepping',
  ready_for_pickup: 'Ready for pickup',
  awaiting_driver: 'Finding a driver',
  dispatch_failed: 'Dispatch failed',
  driver_assigned: 'Driver en route',
  en_route_pickup: 'Driver en route',
  picked_up: 'Picked up',
  en_route_dropoff: 'Out for delivery',
  arrived_at_dropoff: 'Arrived at customer',
  id_scan_pending: 'ID scan pending',
  id_scan_passed: 'ID scan passed',
  id_scan_failed: 'ID scan failed',
  delivered: 'Delivered',
  returned_to_store: 'Returned to store',
  canceled: 'Canceled',
  disputed: 'Disputed',
};

const ORDER_STATUS_TONE: Readonly<Record<OrderStatus, BadgeTone>> = {
  placed: 'info',
  payment_failed: 'danger',
  accepted: 'accent',
  rejected: 'danger',
  prepping: 'accent',
  ready_for_pickup: 'warning',
  awaiting_driver: 'warning',
  dispatch_failed: 'danger',
  driver_assigned: 'accent',
  en_route_pickup: 'accent',
  picked_up: 'accent',
  en_route_dropoff: 'accent',
  arrived_at_dropoff: 'accent',
  id_scan_pending: 'warning',
  id_scan_passed: 'accent',
  id_scan_failed: 'danger',
  delivered: 'success',
  returned_to_store: 'neutral',
  canceled: 'neutral',
  disputed: 'danger',
};

export function orderStatusLabel(status: OrderStatus): string {
  return ORDER_STATUS_LABEL[status];
}

export function orderStatusTone(status: OrderStatus): BadgeTone {
  return ORDER_STATUS_TONE[status];
}
