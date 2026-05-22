/**
 * Display helpers for the staff surface. Pure functions — the rows render
 * server-side and the unit tests verify these in isolation without React
 * or Next runtime.
 */
import type { VendorStaffMember, VendorStaffRole } from '../api/vendor-staff.js';

const ROLE_LABELS: Readonly<Record<VendorStaffRole, string>> = {
  budtender: 'Budtender',
  manager: 'Manager',
  owner: 'Owner',
};

const ROLE_BLURBS: Readonly<Record<VendorStaffRole, string>> = {
  budtender: 'Fulfills orders. No payouts, analytics, settings, or staff access.',
  manager: 'Runs the store day-to-day. Sees payouts, analytics, menu, staff (no owner ops).',
  owner: 'Full control: settings, billing, staff (including other owners), legal docs.',
};

export function roleLabel(role: VendorStaffRole): string {
  return ROLE_LABELS[role];
}

export function roleBlurb(role: VendorStaffRole): string {
  return ROLE_BLURBS[role];
}

export const STAFF_ROLES: readonly VendorStaffRole[] = ['budtender', 'manager', 'owner'];

export type StaffStatus = 'active' | 'pending' | 'removed';

export function staffStatus(member: VendorStaffMember): StaffStatus {
  if (member.removedAt !== null) return 'removed';
  if (member.acceptedAt === null) return 'pending';
  return 'active';
}

const STATUS_LABELS: Readonly<Record<StaffStatus, string>> = {
  active: 'Active',
  pending: 'Invite sent',
  removed: 'Removed',
};

export function statusLabel(status: StaffStatus): string {
  return STATUS_LABELS[status];
}

/**
 * "Casey M." — privacy-respecting variant matching the queue/payout
 * conventions. Falls back to the email address when both names are
 * missing so the operator can always tell who the row refers to.
 */
export function formatStaffDisplayName(member: VendorStaffMember): string {
  const first = member.firstName?.trim() ?? '';
  const last = member.lastName?.trim() ?? '';
  if (first === '' && last === '') return member.email;
  if (last === '') return first;
  const initial = last.charAt(0);
  if (first === '') return `${initial}.`;
  return `${first} ${initial}.`;
}

/**
 * ISO-8601 UTC → "May 18, 2026, 3:15 AM CDT" rendered in America/Chicago
 * so the operator reads it in their store's local calendar. Returns "—"
 * for null. Mirrors payouts/format.ts so the surfaces feel consistent.
 */
export function formatStaffTimestamp(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
    timeZoneName: 'short',
  }).format(date);
}

/**
 * Trim + RFC 5322-lite email check (one `@`, one `.`, no whitespace).
 * The server is authoritative; this only blocks the obvious typos
 * before we hit the network so the user gets feedback in the same
 * keystroke.
 */
export function isLikelyEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 320) return false;
  if (/\s/u.test(trimmed)) return false;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false;
  const domain = trimmed.slice(at + 1);
  if (domain.length < 3 || !domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}
