import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TopBar, computeInitials } from './top-bar.js';

vi.mock('next-auth/react', () => ({
  signOut: vi.fn(),
}));

describe('computeInitials', () => {
  it('uses first + last initials when a multi-part name is present', () => {
    expect(computeInitials('Avery Stone', 'a@x.com')).toBe('AS');
  });

  it('uses two letters from a single-word name', () => {
    expect(computeInitials('Avery', 'a@x.com')).toBe('AV');
  });

  it('falls back to the email when no display name is set', () => {
    expect(computeInitials(null, 'jordan@dankdash.com')).toBe('JO');
  });

  it('uses first and last when the name has three or more parts', () => {
    expect(computeInitials('Mary Anne Smith', 'm@x.com')).toBe('MS');
  });

  it('trims whitespace before computing initials', () => {
    expect(computeInitials('  Avery   Stone  ', 'a@x.com')).toBe('AS');
  });
});

describe('TopBar', () => {
  it('renders the display name, role, and dispensary scope', () => {
    render(
      <TopBar
        email="avery@dankdash.com"
        displayName="Avery Stone"
        role="manager"
        dispensaryName="North Loop"
      />,
    );

    expect(screen.getByText('Avery Stone')).toBeInTheDocument();
    expect(screen.getByText('manager')).toBeInTheDocument();
    expect(screen.getByText('North Loop')).toBeInTheDocument();
  });

  it('falls back to email when no display name is provided', () => {
    render(<TopBar email="avery@dankdash.com" displayName={null} role="owner" />);
    expect(screen.getByText('avery@dankdash.com')).toBeInTheDocument();
    expect(screen.getByText('No dispensary selected')).toBeInTheDocument();
  });

  it('opens and closes the menu when the user button is clicked', async () => {
    const user = userEvent.setup();
    render(<TopBar email="a@x.com" displayName="Avery" role="manager" />);

    const trigger = screen.getByRole('button', { expanded: false });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
