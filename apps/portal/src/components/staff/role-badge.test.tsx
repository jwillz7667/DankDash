import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RoleBadge } from './role-badge.js';
import { StaffStatusBadge } from './status-badge.js';

describe('RoleBadge', () => {
  it('renders the human label for each role', () => {
    const { rerender } = render(<RoleBadge role="budtender" />);
    expect(screen.getByText('Budtender')).toBeInTheDocument();
    rerender(<RoleBadge role="manager" />);
    expect(screen.getByText('Manager')).toBeInTheDocument();
    rerender(<RoleBadge role="owner" />);
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });
});

describe('StaffStatusBadge', () => {
  it('renders the human label for each status', () => {
    const { rerender } = render(<StaffStatusBadge status="active" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    rerender(<StaffStatusBadge status="pending" />);
    expect(screen.getByText('Invite sent')).toBeInTheDocument();
    rerender(<StaffStatusBadge status="removed" />);
    expect(screen.getByText('Removed')).toBeInTheDocument();
  });
});
