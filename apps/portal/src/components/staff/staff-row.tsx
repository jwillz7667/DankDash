'use client';

/**
 * Single row of the staff roster. The row owns the inline role change
 * + remove controls; the parent table owns the snapshot and merges the
 * patched / removed row back via `onPatched` / `onRemoved`.
 *
 * Self-row guard:
 *   - When `isSelf` is true (caller looking at their own row), role
 *     change and remove are disabled with a hover tooltip. The API
 *     enforces the same invariant; the UI guard exists so the operator
 *     never has to read an error to learn why the button is dead.
 *
 * Role assignment constraints:
 *   - `canAssignOwner` = false hides the `owner` option from the role
 *     select. Managers can still demote owners-to-managers though, so
 *     the select stays enabled — the API's `lastOwner` invariant is
 *     the one that prevents the destructive case.
 *
 * Remove confirmation:
 *   - Two-step: clicking "Remove" flips the row into a confirm strip;
 *     "Confirm" actually fires the DELETE. The strip avoids a modal
 *     (which would block the table behind it) while still preventing
 *     a single-misclick from revoking access mid-shift.
 */
import { Loader2, ShieldX, X } from 'lucide-react';
import { useCallback, useId, useState, type ReactNode } from 'react';
import { ApiError } from '../../lib/api/client.js';
import {
  formatStaffDisplayName,
  formatStaffTimestamp,
  roleLabel,
  staffStatus,
  STAFF_ROLES,
} from '../../lib/staff/format.js';
import { Button } from '../ui/button.js';
import { RoleBadge } from './role-badge.js';
import { StaffStatusBadge } from './status-badge.js';
import type {
  PatchStaffInput,
  VendorStaffMember,
  VendorStaffRole,
} from '../../lib/api/vendor-staff.js';

export interface StaffRowProps {
  readonly member: VendorStaffMember;
  /** True when this row represents the currently signed-in operator. */
  readonly isSelf: boolean;
  /** Owner-level caller? Drives whether `owner` is a valid target role. */
  readonly canAssignOwner: boolean;
  readonly onPatchRole: (id: string, input: PatchStaffInput) => Promise<VendorStaffMember>;
  readonly onRemove: (id: string) => Promise<void>;
  readonly onPatched: (member: VendorStaffMember) => void;
  readonly onRemoved: (id: string) => void;
}

export function StaffRow({
  member,
  isSelf,
  canAssignOwner,
  onPatchRole,
  onRemove,
  onPatched,
  onRemoved,
}: StaffRowProps): ReactNode {
  const status = staffStatus(member);
  const isRemoved = status === 'removed';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const roleSelectId = useId();

  const availableRoles = canAssignOwner
    ? STAFF_ROLES
    : STAFF_ROLES.filter((r) => r !== 'owner' || r === member.role);

  const handleRoleChange = useCallback(
    async (next: VendorStaffRole): Promise<void> => {
      if (next === member.role) return;
      setError(null);
      setBusy(true);
      try {
        const patched = await onPatchRole(member.id, { role: next });
        onPatched(patched);
      } catch (err) {
        setError(extractRoleChangeError(err));
      } finally {
        setBusy(false);
      }
    },
    [member.id, member.role, onPatchRole, onPatched],
  );

  const handleRemove = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await onRemove(member.id);
      onRemoved(member.id);
    } catch (err) {
      setError(extractRemoveError(err));
      setBusy(false);
    }
    // Don't reset busy on success — the row will be removed from the
    // snapshot, so any local state is about to be unmounted.
  }, [member.id, onRemove, onRemoved]);

  return (
    <tr className={isRemoved ? 'opacity-60' : ''}>
      <td className="px-5 py-4">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-slate-900">
            {formatStaffDisplayName(member)}
            {isSelf ? (
              <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-slate-600">
                You
              </span>
            ) : null}
          </span>
          <span className="text-xs text-slate-500">{member.email}</span>
        </div>
      </td>
      <td className="px-3 py-4">
        {isRemoved || isSelf ? (
          <RoleBadge role={member.role} />
        ) : (
          <label className="block">
            <span className="sr-only" id={roleSelectId}>
              Role for {member.email}
            </span>
            <select
              aria-labelledby={roleSelectId}
              value={member.role}
              onChange={(e) => {
                void handleRoleChange(e.target.value as VendorStaffRole);
              }}
              disabled={busy}
              className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 focus:border-moss-500 focus:outline-none focus:ring-2 focus:ring-moss-500/30 disabled:cursor-not-allowed disabled:bg-slate-50"
            >
              {availableRoles.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </label>
        )}
      </td>
      <td className="px-3 py-4">
        <StaffStatusBadge status={status} />
      </td>
      <td className="px-3 py-4 text-sm text-slate-600">
        {member.mfaEnabled ? 'On' : <span className="text-amber-700">Off</span>}
      </td>
      <td className="px-3 py-4 text-sm text-slate-500">
        {formatStaffTimestamp(member.lastLoginAt)}
      </td>
      <td className="px-5 py-4 text-right">
        {isRemoved ? (
          <span className="text-xs text-slate-500">
            Removed {formatStaffTimestamp(member.removedAt)}
          </span>
        ) : isSelf ? (
          <span className="text-xs text-slate-400" title="You can't remove yourself.">
            —
          </span>
        ) : confirmingRemove ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirmingRemove(false);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                void handleRemove();
              }}
              disabled={busy}
            >
              {busy ? (
                <>
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                  Removing…
                </>
              ) : (
                'Confirm remove'
              )}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirmingRemove(true);
            }}
            disabled={busy}
            aria-label={`Remove ${member.email}`}
          >
            <ShieldX aria-hidden="true" className="h-3.5 w-3.5" />
            Remove
          </Button>
        )}
        {error !== null ? (
          <p
            role="alert"
            className="mt-1 flex items-center justify-end gap-1 text-xs text-rose-700"
          >
            <X aria-hidden="true" className="h-3 w-3" />
            {error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

function extractRoleChangeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You can't assign that role.";
    if (err.status === 409) return 'That change would leave the store without an owner.';
    if (err.status === 404) return 'That teammate is no longer in the roster.';
    if (err.status === 422) return err.envelope?.error.message ?? "Couldn't change role.";
  }
  return "Couldn't change role. Try again.";
}

function extractRemoveError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return 'Removing them would leave the store without an owner.';
    if (err.status === 403) return "You can't remove that teammate.";
    if (err.status === 404) return 'That teammate is already gone.';
  }
  return "Couldn't remove. Try again.";
}
