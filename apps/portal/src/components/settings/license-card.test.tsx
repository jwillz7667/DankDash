import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LicenseCard } from './license-card.js';

const NOW = new Date('2026-05-20T12:00:00.000Z');

const BASE = {
  licenseNumber: 'MN-2025-0001',
  licenseType: 'retailer' as const,
  licenseIssuedAt: '2025-01-01',
};

describe('LicenseCard', () => {
  it('renders the license metadata', () => {
    render(<LicenseCard {...BASE} licenseExpiresAt="2027-01-01" now={NOW} />);
    expect(screen.getByText('MN-2025-0001')).toBeInTheDocument();
    expect(screen.getByText('Retailer')).toBeInTheDocument();
  });

  it('flags expired licenses with a danger banner', () => {
    render(<LicenseCard {...BASE} licenseExpiresAt="2026-04-01" now={NOW} />);
    const status = screen.getByTestId('license-status');
    expect(status.textContent).toMatch(/Expired/u);
    expect(screen.getByRole('alert').textContent).toMatch(/expired/iu);
  });

  it('flags critical licenses (≤30d) with a danger banner', () => {
    render(<LicenseCard {...BASE} licenseExpiresAt="2026-06-10" now={NOW} />);
    const status = screen.getByTestId('license-status');
    expect(status.textContent).toMatch(/Expires in/u);
    expect(screen.getByRole('alert').textContent).toMatch(/Renewal is overdue or imminent/iu);
  });

  it('flags warn (30-90d) with an amber banner', () => {
    render(<LicenseCard {...BASE} licenseExpiresAt="2026-08-01" now={NOW} />);
    expect(screen.getByRole('alert').textContent).toMatch(/renewal window/iu);
  });

  it('shows no banner when the license is current', () => {
    render(<LicenseCard {...BASE} licenseExpiresAt="2027-01-01" now={NOW} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('license-status').textContent).toMatch(/Current/u);
  });
});
