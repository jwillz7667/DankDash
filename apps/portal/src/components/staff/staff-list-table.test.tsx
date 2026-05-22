import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  InviteStaffInput,
  PatchStaffInput,
  VendorStaffMember,
  VendorStaffRole,
} from '../../lib/api/vendor-staff.js';
import type { VendorStaffActions } from '../../lib/staff/staff-actions.js';
import { StaffListTable } from './staff-list-table.js';

const DISPENSARY_ID = '01935f3d-0000-7000-8000-0000000000d1';
const CURRENT_USER_ID = '01935f3d-0000-7000-8000-0000000000a1';
void DISPENSARY_ID;

function member(overrides: Partial<VendorStaffMember> = {}): VendorStaffMember {
  return {
    id: '01935f3d-0000-7000-8000-0000000000b1',
    userId: '01935f3d-0000-7000-8000-0000000000b9',
    role: 'budtender',
    email: 'budtender@example.com',
    firstName: 'Robin',
    lastName: 'Bud',
    mfaEnabled: false,
    lastLoginAt: null,
    invitedAt: '2026-05-15T00:00:00.000Z',
    acceptedAt: '2026-05-15T01:00:00.000Z',
    removedAt: null,
    ...overrides,
  };
}

function selfMember(overrides: Partial<VendorStaffMember> = {}): VendorStaffMember {
  return member({
    id: '01935f3d-0000-7000-8000-0000000000aa',
    userId: CURRENT_USER_ID,
    role: 'owner',
    email: 'owner@example.com',
    firstName: 'Casey',
    lastName: 'Owner',
    mfaEnabled: true,
    lastLoginAt: '2026-05-19T12:00:00.000Z',
    invitedAt: '2026-05-01T00:00:00.000Z',
    acceptedAt: '2026-05-01T01:00:00.000Z',
    ...overrides,
  });
}

function makeActions(overrides: Partial<VendorStaffActions> = {}): VendorStaffActions {
  return {
    list: overrides.list ?? (() => Promise.resolve([])),
    invite: overrides.invite ?? (() => Promise.reject(new Error('invite not stubbed'))),
    patchRole: overrides.patchRole ?? (() => Promise.reject(new Error('patchRole not stubbed'))),
    remove: overrides.remove ?? (() => Promise.resolve()),
  };
}

function renderTable(
  initial: readonly VendorStaffMember[],
  actions: VendorStaffActions,
  role: VendorStaffRole = 'owner',
): void {
  render(
    <StaffListTable
      initialStaff={initial}
      actions={actions}
      currentUserId={CURRENT_USER_ID}
      currentStaffRole={role}
    />,
  );
}

describe('StaffListTable rendering', () => {
  it('renders the empty state when the roster is empty', () => {
    renderTable([], makeActions());
    expect(screen.getByText(/No teammates yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('staff-table')).not.toBeInTheDocument();
  });

  it('renders one row per member with the running count summary', () => {
    renderTable(
      [
        selfMember(),
        member({ id: 'b1', userId: 'u-b1', email: 'one@example.com' }),
        member({
          id: 'b2',
          userId: 'u-b2',
          email: 'pending@example.com',
          acceptedAt: null,
        }),
        member({
          id: 'b3',
          userId: 'u-b3',
          email: 'gone@example.com',
          removedAt: '2026-05-18T00:00:00.000Z',
        }),
      ],
      makeActions(),
    );
    const rows = within(screen.getByTestId('staff-table')).getAllByRole('row');
    // 1 header row + 4 data rows
    expect(rows).toHaveLength(5);
    expect(screen.getByText(/2 active · 1 pending · 1 removed/u)).toBeInTheDocument();
  });

  it('marks the operator\'s own row with a "You" badge', () => {
    renderTable([selfMember()], makeActions());
    expect(screen.getByText('You')).toBeInTheDocument();
  });
});

describe('StaffListTable role gating', () => {
  it('hides the owner option from the invite form when caller is a manager', () => {
    renderTable([], makeActions(), 'manager');
    const select = screen.getByLabelText('Role') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['budtender', 'manager']);
  });

  it('exposes the owner option to an owner caller', () => {
    renderTable([], makeActions(), 'owner');
    const select = screen.getByLabelText('Role') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['budtender', 'manager', 'owner']);
  });
});

describe('StaffListTable invite flow', () => {
  it('invites a new member and merges them into the roster', async () => {
    const newMember = member({
      id: 'new-1',
      userId: 'u-new',
      email: 'invitee@example.com',
      acceptedAt: null,
      role: 'manager',
    });
    const invite = vi.fn(async (_input: InviteStaffInput) => newMember);
    renderTable([], makeActions({ invite }));

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'invitee@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'manager' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => {
      expect(invite).toHaveBeenCalledWith({
        email: 'invitee@example.com',
        role: 'manager',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('invitee@example.com')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent(/Invite sent to invitee@example.com/u);
  });

  it('rejects an obviously bad email before hitting the network', async () => {
    const invite = vi.fn();
    renderTable([], makeActions({ invite }));
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);
    });
    expect(invite).not.toHaveBeenCalled();
  });
});

describe('StaffListTable role change', () => {
  it('PATCHes the role and merges the updated row', async () => {
    const target = member({ id: 't-1', userId: 'u-t-1', email: 'pat@example.com' });
    const updated: VendorStaffMember = { ...target, role: 'manager' };
    const patchRole = vi.fn(async (_id: string, _input: PatchStaffInput) => updated);
    renderTable([target], makeActions({ patchRole }));

    const select = screen.getByLabelText(/Role for pat@example.com/u) as HTMLSelectElement;
    expect(select.value).toBe('budtender');
    fireEvent.change(select, { target: { value: 'manager' } });

    await waitFor(() => {
      expect(patchRole).toHaveBeenCalledWith(target.id, { role: 'manager' });
    });
    await waitFor(() => {
      // Manager badge should now appear on the row.
      expect(screen.getAllByText('Manager').length).toBeGreaterThan(0);
    });
  });

  it("disables role change on the operator's own row", () => {
    renderTable([selfMember()], makeActions());
    expect(screen.queryByLabelText(/Role for owner@example.com/u)).not.toBeInTheDocument();
  });
});

describe('StaffListTable remove flow', () => {
  it('requires a confirm click before firing remove', async () => {
    const remove = vi.fn(async () => undefined);
    const target = member({ id: 'r-1', userId: 'u-r-1', email: 'remove@example.com' });
    renderTable([target], makeActions({ remove }));

    fireEvent.click(screen.getByRole('button', { name: /remove remove@example\.com/iu }));
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /confirm remove/i }));
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith(target.id);
    });
    // After remove, the row's status badge flips to Removed.
    await waitFor(() => {
      expect(screen.getByText('Removed')).toBeInTheDocument();
    });
  });

  it("hides the remove control on the operator's own row", () => {
    renderTable([selfMember()], makeActions());
    expect(
      screen.queryByRole('button', { name: /remove owner@example\.com/iu }),
    ).not.toBeInTheDocument();
  });
});
