import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from './sidebar.js';

const pathnameMock = vi.fn<() => string>();

vi.mock('next/navigation', () => ({
  usePathname: (): string => pathnameMock(),
}));

describe('Sidebar', () => {
  it('renders only the items a budtender role is allowed to see', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<Sidebar role="budtender" />);

    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Orders' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Menu' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Staff' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Payouts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('renders the full nav for owners', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<Sidebar role="owner" />);

    for (const label of [
      'Dashboard',
      'Orders',
      'Menu',
      'Staff',
      'Payouts',
      'Analytics',
      'Settings',
    ]) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the active route via aria-current="page"', () => {
    pathnameMock.mockReturnValue('/orders');
    render(<Sidebar role="manager" />);

    const orders = screen.getByRole('link', { name: 'Orders' });
    expect(orders).toHaveAttribute('aria-current', 'page');

    const dashboard = screen.getByRole('link', { name: 'Dashboard' });
    expect(dashboard).not.toHaveAttribute('aria-current');
  });

  it('treats any /settings/* path as active for the Settings link', () => {
    pathnameMock.mockReturnValue('/settings/integrations');
    render(<Sidebar role="manager" />);

    const settings = screen.getByRole('link', { name: 'Settings' });
    expect(settings).toHaveAttribute('aria-current', 'page');
  });
});
