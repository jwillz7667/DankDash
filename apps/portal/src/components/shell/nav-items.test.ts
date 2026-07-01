import { describe, expect, it } from 'vitest';
import { PRIMARY_NAV, SETTINGS_NAV, visibleFor } from './nav-items.js';

describe('visibleFor', () => {
  it('hides manager-only items from budtenders', () => {
    const items = visibleFor(PRIMARY_NAV, 'budtender');
    const keys = items.map((i) => i.key);

    expect(keys).toContain('dashboard');
    expect(keys).toContain('orders');
    expect(keys).toContain('menu');
    expect(keys).toContain('analytics');
    // Products is open to every vendor role — a budtender can author catalog
    // products (the server still enforces all compliance limits).
    expect(keys).toContain('products');
    expect(keys).not.toContain('staff');
    expect(keys).not.toContain('payouts');
    expect(keys).not.toContain('settings');
  });

  it('shows the full primary nav to managers', () => {
    const items = visibleFor(PRIMARY_NAV, 'manager');
    expect(items.map((i) => i.key)).toEqual([
      'dashboard',
      'orders',
      'menu',
      'products',
      'staff',
      'payouts',
      'analytics',
      'settings',
    ]);
  });

  it('shows the full primary nav to owners, admins, and superadmins', () => {
    for (const role of ['owner', 'admin', 'superadmin'] as const) {
      expect(visibleFor(PRIMARY_NAV, role)).toHaveLength(PRIMARY_NAV.length);
    }
  });

  it('hides the settings sub-nav from budtenders entirely', () => {
    expect(visibleFor(SETTINGS_NAV, 'budtender')).toHaveLength(0);
  });

  it('exposes every settings sub-route to managers and above', () => {
    for (const role of ['manager', 'owner', 'admin', 'superadmin'] as const) {
      expect(visibleFor(SETTINGS_NAV, role)).toHaveLength(SETTINGS_NAV.length);
    }
  });

  it('returns an empty list for non-portal roles', () => {
    expect(visibleFor(PRIMARY_NAV, 'customer')).toHaveLength(0);
    expect(visibleFor(PRIMARY_NAV, 'driver')).toHaveLength(0);
  });

  it('preserves input order in the filtered output', () => {
    const items = visibleFor(PRIMARY_NAV, 'owner');
    const indices = items.map((i) => PRIMARY_NAV.findIndex((p) => p.key === i.key));
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });
});
