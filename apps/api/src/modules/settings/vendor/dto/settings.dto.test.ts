import { describe, expect, it } from 'vitest';
import { PatchVendorSettingsSchema } from './settings.dto.js';

describe('PatchVendorSettingsSchema', () => {
  it('accepts a single editable field', () => {
    const parsed = PatchVendorSettingsSchema.parse({ isAcceptingOrders: false });
    expect(parsed).toEqual({ isAcceptingOrders: false });
  });

  it('accepts a full hours schedule', () => {
    const hours = {
      mon: { open: '08:00', close: '22:00' },
      tue: { open: '08:00', close: '22:00' },
      wed: { open: '08:00', close: '22:00' },
      thu: { open: '08:00', close: '22:00' },
      fri: { open: '08:00', close: '22:00' },
      sat: { open: '10:00', close: '22:00' },
      sun: null,
    };
    const parsed = PatchVendorSettingsSchema.parse({ hours });
    expect(parsed.hours).toEqual(hours);
  });

  it('rejects an empty payload', () => {
    expect(() => PatchVendorSettingsSchema.parse({})).toThrow(/at least one field/u);
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => PatchVendorSettingsSchema.parse({ legalName: 'New LLC' })).toThrow();
  });

  it('rejects invalid brand colors', () => {
    expect(() => PatchVendorSettingsSchema.parse({ brandColorHex: 'forest' })).toThrow(/#RRGGBB/u);
    expect(() => PatchVendorSettingsSchema.parse({ brandColorHex: '#ABC' })).toThrow(/#RRGGBB/u);
  });

  it('rejects malformed hours strings', () => {
    expect(() =>
      PatchVendorSettingsSchema.parse({
        hours: {
          mon: { open: '8am', close: '10pm' },
          tue: null,
          wed: null,
          thu: null,
          fri: null,
          sat: null,
          sun: null,
        },
      }),
    ).toThrow();
  });

  it('allows nullable phone/email/brand color', () => {
    const parsed = PatchVendorSettingsSchema.parse({
      phone: null,
      email: null,
      brandColorHex: null,
      logoImageKey: null,
      heroImageKey: null,
    });
    expect(parsed).toEqual({
      phone: null,
      email: null,
      brandColorHex: null,
      logoImageKey: null,
      heroImageKey: null,
    });
  });

  it('validates phone format permissively', () => {
    const parsed = PatchVendorSettingsSchema.parse({ phone: '+1 (612) 555-0100' });
    expect(parsed.phone).toBe('+1 (612) 555-0100');
    expect(() => PatchVendorSettingsSchema.parse({ phone: 'call me' })).toThrow(/illegal/u);
  });

  it('validates email', () => {
    expect(() => PatchVendorSettingsSchema.parse({ email: 'not-an-email' })).toThrow();
  });
});
