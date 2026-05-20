import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsTabs } from './analytics-tabs.js';

vi.mock('next/navigation', () => ({
  usePathname: (): string => '/analytics/sales',
  useSearchParams: (): URLSearchParams =>
    new URLSearchParams('from=2026-05-13T00%3A00%3A00.000Z&to=2026-05-20T00%3A00%3A00.000Z'),
}));

describe('AnalyticsTabs', () => {
  it('renders Sales + Products tab links and marks the active route', () => {
    render(<AnalyticsTabs />);
    const sales = screen.getByRole('link', { name: 'Sales' });
    const products = screen.getByRole('link', { name: 'Products' });
    expect(sales).toBeInTheDocument();
    expect(products).toBeInTheDocument();
    expect(sales).toHaveAttribute('aria-current', 'page');
    expect(products).not.toHaveAttribute('aria-current');
  });

  it('preserves the date query string across the tab links', () => {
    render(<AnalyticsTabs />);
    const sales = screen.getByRole('link', { name: 'Sales' });
    const products = screen.getByRole('link', { name: 'Products' });
    expect(sales.getAttribute('href')).toContain('from=');
    expect(sales.getAttribute('href')).toContain('to=');
    expect(products.getAttribute('href')).toContain('from=');
    expect(products.getAttribute('href')).toContain('to=');
  });
});
