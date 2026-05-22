'use client';

/**
 * Vendor staff roster. Owns the local snapshot, hosts the invite form
 * (owner/manager only), and renders one StaffRow per member. Removed
 * members stay in the table — operators need to audit who used to have
 * access — but they sort to the bottom and render at reduced opacity.
 *
 * Mirrors the menu-table pattern: seed from server-fetched
 * `initialStaff`, manage state via `useState`, merge mutations back
 * into the snapshot. The page itself stays a thin server component.
 */
import { Users } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { staffStatus } from '../../lib/staff/format.js';
import { InviteStaffForm } from './invite-staff-form.js';
import { StaffRow } from './staff-row.js';
import type { VendorStaffMember, VendorStaffRole } from '../../lib/api/vendor-staff.js';
import type { VendorStaffActions } from '../../lib/staff/staff-actions.js';

export interface StaffListTableProps {
  readonly initialStaff: readonly VendorStaffMember[];
  readonly actions: VendorStaffActions;
  /** Current operator's user id; rows with that userId render as "You". */
  readonly currentUserId: string;
  /** Operator's role on the active dispensary. Drives invite + role gating. */
  readonly currentStaffRole: VendorStaffRole;
}

export function StaffListTable({
  initialStaff,
  actions,
  currentUserId,
  currentStaffRole,
}: StaffListTableProps): ReactNode {
  const [staff, setStaff] = useState<readonly VendorStaffMember[]>(() =>
    [...initialStaff].sort(compareStaff),
  );
  const canAssignOwner = currentStaffRole === 'owner';

  const handleInvited = useCallback((member: VendorStaffMember): void => {
    setStaff((prev) => mergeOrInsert(prev, member));
  }, []);

  const handlePatched = useCallback((member: VendorStaffMember): void => {
    setStaff((prev) => mergeOrInsert(prev, member));
  }, []);

  const handleRemoved = useCallback((removedId: string): void => {
    setStaff((prev) => {
      const next = prev.map((m) =>
        m.id === removedId && m.removedAt === null
          ? { ...m, removedAt: new Date().toISOString() }
          : m,
      );
      next.sort(compareStaff);
      return next;
    });
  }, []);

  const { active, pending, removed } = useMemo(() => {
    const a: VendorStaffMember[] = [];
    const p: VendorStaffMember[] = [];
    const r: VendorStaffMember[] = [];
    for (const m of staff) {
      const s = staffStatus(m);
      if (s === 'active') a.push(m);
      else if (s === 'pending') p.push(m);
      else r.push(m);
    }
    return { active: a, pending: p, removed: r };
  }, [staff]);

  return (
    <div className="flex flex-col gap-6">
      <InviteStaffForm
        onInvite={actions.invite}
        onInvited={handleInvited}
        canAssignOwner={canAssignOwner}
      />

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-slate-900">Roster</h2>
            <p className="text-sm text-slate-500">
              {active.length} active · {pending.length} pending · {removed.length} removed
            </p>
          </div>
        </div>

        {staff.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="staff-table">
              <thead className="border-b border-slate-100 bg-slate-50/50 text-2xs font-medium uppercase tracking-wider text-slate-500">
                <tr>
                  <th scope="col" className="py-3 pl-5 pr-3">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Role
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-3">
                    MFA
                  </th>
                  <th scope="col" className="px-3 py-3">
                    Last login
                  </th>
                  <th scope="col" className="pl-3 pr-5 py-3 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {staff.map((member) => (
                  <StaffRow
                    key={member.id}
                    member={member}
                    isSelf={member.userId === currentUserId}
                    canAssignOwner={canAssignOwner}
                    onPatchRole={actions.patchRole}
                    onRemove={actions.remove}
                    onPatched={handlePatched}
                    onRemoved={handleRemoved}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Sort order: active first, then pending, then removed. Within each
 * group, most-recently-invited last (older first so the original
 * owners stay visible at the top of the roster). The API already
 * returns this order, but the merge-on-mutation can disturb it.
 */
function compareStaff(a: VendorStaffMember, b: VendorStaffMember): number {
  const groupA = statusOrder(a);
  const groupB = statusOrder(b);
  if (groupA !== groupB) return groupA - groupB;
  // Within group: oldest invitedAt first.
  const ia = Date.parse(a.invitedAt);
  const ib = Date.parse(b.invitedAt);
  if (Number.isNaN(ia) || Number.isNaN(ib)) return 0;
  return ia - ib;
}

function statusOrder(member: VendorStaffMember): number {
  const s = staffStatus(member);
  if (s === 'active') return 0;
  if (s === 'pending') return 1;
  return 2;
}

function mergeOrInsert(
  prev: readonly VendorStaffMember[],
  member: VendorStaffMember,
): readonly VendorStaffMember[] {
  const existingIndex = prev.findIndex((m) => m.id === member.id);
  const next =
    existingIndex >= 0 ? prev.map((m, i) => (i === existingIndex ? member : m)) : [...prev, member];
  next.sort(compareStaff);
  return next;
}

function EmptyState(): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss-50 text-moss-700">
        <Users aria-hidden="true" className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold tracking-tight text-slate-900">No teammates yet</h3>
        <p className="max-w-sm text-sm text-slate-500">
          Invite the operators who need access to this store. They'll receive a sign-in email and
          show up here as soon as they accept.
        </p>
      </div>
    </div>
  );
}
