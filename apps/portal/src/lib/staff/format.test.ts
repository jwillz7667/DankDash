import { describe, expect, it } from 'vitest';
import type { VendorStaffMember } from '../api/vendor-staff.js';
import {
  formatStaffDisplayName,
  formatStaffTimestamp,
  isLikelyEmail,
  roleBlurb,
  roleLabel,
  staffStatus,
  statusLabel,
  STAFF_ROLES,
} from './format.js';

const BASE: VendorStaffMember = {
  id: '01935f3d-0000-7000-8000-0000000000a3',
  userId: '01935f3d-0000-7000-8000-0000000000a5',
  role: 'manager',
  email: 'mgr@example.com',
  firstName: 'Casey',
  lastName: 'Manager',
  mfaEnabled: true,
  lastLoginAt: '2026-05-19T12:00:00.000Z',
  invitedAt: '2026-05-01T00:00:00.000Z',
  acceptedAt: '2026-05-01T01:00:00.000Z',
  removedAt: null,
};

describe('roleLabel + roleBlurb + STAFF_ROLES', () => {
  it('returns a human label per role', () => {
    expect(roleLabel('budtender')).toBe('Budtender');
    expect(roleLabel('manager')).toBe('Manager');
    expect(roleLabel('owner')).toBe('Owner');
  });

  it('returns a one-line scope blurb per role', () => {
    expect(roleBlurb('budtender')).toContain('Fulfills orders');
    expect(roleBlurb('manager')).toContain('day-to-day');
    expect(roleBlurb('owner')).toContain('Full control');
  });

  it('exposes the role order from least → most privileged', () => {
    expect(STAFF_ROLES).toEqual(['budtender', 'manager', 'owner']);
  });
});

describe('staffStatus + statusLabel', () => {
  it('removed beats everything', () => {
    const member = { ...BASE, removedAt: '2026-05-19T12:00:00.000Z' };
    expect(staffStatus(member)).toBe('removed');
    expect(statusLabel('removed')).toBe('Removed');
  });

  it('pending when never accepted', () => {
    const member = { ...BASE, acceptedAt: null };
    expect(staffStatus(member)).toBe('pending');
    expect(statusLabel('pending')).toBe('Invite sent');
  });

  it('active when accepted and not removed', () => {
    expect(staffStatus(BASE)).toBe('active');
    expect(statusLabel('active')).toBe('Active');
  });
});

describe('formatStaffDisplayName', () => {
  it('renders "First L." with a trailing initial', () => {
    expect(formatStaffDisplayName(BASE)).toBe('Casey M.');
  });

  it('falls back to first name when surname missing', () => {
    expect(formatStaffDisplayName({ ...BASE, lastName: null })).toBe('Casey');
  });

  it('renders "L." when only the surname is known', () => {
    expect(formatStaffDisplayName({ ...BASE, firstName: null })).toBe('M.');
  });

  it('falls back to email when both names are blank', () => {
    expect(formatStaffDisplayName({ ...BASE, firstName: '   ', lastName: '' })).toBe(
      'mgr@example.com',
    );
  });
});

describe('formatStaffTimestamp', () => {
  it('returns "—" for null', () => {
    expect(formatStaffTimestamp(null)).toBe('—');
  });

  it('returns "—" for unparseable input', () => {
    expect(formatStaffTimestamp('not-a-date')).toBe('—');
  });

  it('renders in America/Chicago with the zone abbreviation', () => {
    const out = formatStaffTimestamp('2026-05-19T17:00:00.000Z');
    expect(out).toMatch(/May 19, 2026/u);
    expect(out).toMatch(/C[SD]T/u);
  });
});

describe('isLikelyEmail', () => {
  it('accepts standard addresses', () => {
    expect(isLikelyEmail('a@b.co')).toBe(true);
    expect(isLikelyEmail('  casey@example.com  ')).toBe(true);
  });

  it('rejects empty / whitespace / no @ / no domain dot', () => {
    expect(isLikelyEmail('')).toBe(false);
    expect(isLikelyEmail('   ')).toBe(false);
    expect(isLikelyEmail('not-an-email')).toBe(false);
    expect(isLikelyEmail('two @ats@bad.com')).toBe(false);
    expect(isLikelyEmail('no@dot')).toBe(false);
    expect(isLikelyEmail('trailing.dot@example.')).toBe(false);
  });
});
