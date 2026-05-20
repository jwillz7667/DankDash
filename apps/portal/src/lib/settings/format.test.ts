import { describe, expect, it } from 'vitest';
import type { DispensaryHours } from '../api/vendor-settings.js';
import {
  DAYS,
  formatCalendarDate,
  formatSyncTimestamp,
  hoursEqual,
  isValidHhMm,
  licenseExpiryStatus,
  licenseTypeLabel,
  normalizeDay,
  posProviderLabel,
} from './format.js';

describe('DAYS', () => {
  it('contains seven days in Mon-first order', () => {
    expect(DAYS.map((d) => d.key)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });
});

describe('licenseTypeLabel', () => {
  it('renders human-friendly labels for every type', () => {
    expect(licenseTypeLabel('retailer')).toBe('Retailer');
    expect(licenseTypeLabel('lphe_retailer')).toMatch(/Lower-Potency/u);
    expect(licenseTypeLabel('delivery_service')).toBe('Delivery Service');
  });
});

describe('posProviderLabel', () => {
  it('renders the manual fallback explicitly', () => {
    expect(posProviderLabel('manual')).toMatch(/no POS/u);
    expect(posProviderLabel('dutchie')).toBe('Dutchie');
  });
});

describe('formatCalendarDate', () => {
  it('renders "Mon DD, YYYY"', () => {
    expect(formatCalendarDate('2027-01-15')).toMatch(/Jan 15, 2027/u);
  });

  it('returns the raw input when malformed', () => {
    expect(formatCalendarDate('nope')).toBe('nope');
  });
});

describe('formatSyncTimestamp', () => {
  it('returns "—" for null', () => {
    expect(formatSyncTimestamp(null)).toBe('—');
  });

  it('renders in America/Chicago with the zone abbreviation', () => {
    const out = formatSyncTimestamp('2026-05-19T18:00:00.000Z');
    expect(out).toMatch(/May 19, 2026/u);
    expect(out).toMatch(/C[SD]T/u);
  });
});

describe('licenseExpiryStatus', () => {
  const NOW = new Date('2026-05-20T12:00:00.000Z');

  it('flags expired when the day is in the past', () => {
    const result = licenseExpiryStatus('2026-05-01', NOW);
    expect(result.status).toBe('expired');
    expect(result.daysRemaining).toBeLessThan(0);
  });

  it('flags critical inside the 30-day window', () => {
    const result = licenseExpiryStatus('2026-06-01', NOW);
    expect(result.status).toBe('critical');
    expect(result.daysRemaining).toBeLessThanOrEqual(30);
  });

  it('flags warn between 30 and 90 days', () => {
    const result = licenseExpiryStatus('2026-08-01', NOW);
    expect(result.status).toBe('warn');
  });

  it('flags ok beyond 90 days', () => {
    const result = licenseExpiryStatus('2027-01-01', NOW);
    expect(result.status).toBe('ok');
  });
});

describe('isValidHhMm', () => {
  it('accepts standard HH:MM and the next-day overshoot up to 30:00', () => {
    expect(isValidHhMm('00:00')).toBe(true);
    expect(isValidHhMm('08:00')).toBe(true);
    expect(isValidHhMm('22:30')).toBe(true);
    expect(isValidHhMm('25:00')).toBe(true); // next-day close encoding
    expect(isValidHhMm('30:00')).toBe(true);
  });

  it('rejects malformed strings', () => {
    expect(isValidHhMm('22:60')).toBe(false);
    expect(isValidHhMm('eight')).toBe(false);
    expect(isValidHhMm('')).toBe(false);
    expect(isValidHhMm('31:00')).toBe(false);
  });
});

describe('normalizeDay', () => {
  it('returns null when closed', () => {
    expect(normalizeDay('08:00', '22:00', true)).toBeNull();
  });

  it('returns the open/close pair when not closed', () => {
    expect(normalizeDay('08:00', '22:00', false)).toEqual({ open: '08:00', close: '22:00' });
  });
});

describe('hoursEqual', () => {
  const A: DispensaryHours = {
    mon: { open: '08:00', close: '22:00' },
    tue: { open: '08:00', close: '22:00' },
    wed: { open: '08:00', close: '22:00' },
    thu: { open: '08:00', close: '22:00' },
    fri: { open: '08:00', close: '22:00' },
    sat: { open: '10:00', close: '22:00' },
    sun: null,
  };

  it('is reflexive', () => {
    expect(hoursEqual(A, A)).toBe(true);
  });

  it('detects an open-time change', () => {
    expect(hoursEqual(A, { ...A, mon: { open: '09:00', close: '22:00' } })).toBe(false);
  });

  it('detects a closed-day flip', () => {
    expect(hoursEqual(A, { ...A, sun: { open: '10:00', close: '20:00' } })).toBe(false);
    expect(hoursEqual(A, { ...A, mon: null })).toBe(false);
  });
});
