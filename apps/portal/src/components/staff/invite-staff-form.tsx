'use client';

/**
 * Invite-staff form. Renders an email + role pair and calls the
 * `VendorStaffActions.invite` server action on submit. On success, the
 * caller-supplied `onInvited` merges the new (or resurrected) row into
 * the table snapshot — same merge contract as the menu row's
 * `onPatch`. Errors surface as a transient red message below the form;
 * the operator's recovery is the same regardless of which validation
 * the server tripped, so we don't render machine-readable codes.
 *
 * The role select hides the `owner` choice unless `canAssignOwner` is
 * true so a manager can't even attempt the privilege escalation. The
 * service rejects it server-side too — this is UI clarity, not auth.
 */
import { Loader2, Mail, ShieldPlus } from 'lucide-react';
import { useCallback, useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { ApiError } from '../../lib/api/client.js';
import { isLikelyEmail, roleBlurb, roleLabel, STAFF_ROLES } from '../../lib/staff/format.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import type {
  InviteStaffInput,
  VendorStaffMember,
  VendorStaffRole,
} from '../../lib/api/vendor-staff.js';

export interface InviteStaffFormProps {
  /** Server-action proxy that POSTs /v1/vendor/staff. */
  readonly onInvite: (input: InviteStaffInput) => Promise<VendorStaffMember>;
  /** Parent merges the new (or resurrected) row into its snapshot. */
  readonly onInvited: (member: VendorStaffMember) => void;
  /** When false, the `owner` choice is hidden from the role select. */
  readonly canAssignOwner: boolean;
}

export function InviteStaffForm({
  onInvite,
  onInvited,
  canAssignOwner,
}: InviteStaffFormProps): ReactNode {
  const emailId = useId();
  const roleId = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<VendorStaffRole>('budtender');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const availableRoles = canAssignOwner ? STAFF_ROLES : STAFF_ROLES.filter((r) => r !== 'owner');

  const handleSubmit = useCallback(
    async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      setError(null);
      setSuccess(null);
      const trimmed = email.trim();
      if (!isLikelyEmail(trimmed)) {
        setError('Enter a valid email address.');
        return;
      }
      setBusy(true);
      try {
        const member = await onInvite({ email: trimmed, role });
        onInvited(member);
        setEmail('');
        setRole('budtender');
        setSuccess(`Invite sent to ${trimmed}.`);
      } catch (err) {
        setError(extractInviteError(err));
      } finally {
        setBusy(false);
      }
    },
    [email, role, onInvite, onInvited],
  );

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      className="flex flex-col gap-4 rounded-2xl border border-outline bg-surface p-5 shadow-sm"
      noValidate
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-moss-50 text-moss-700">
          <ShieldPlus aria-hidden="true" className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Invite a teammate
          </h2>
          <p className="text-sm text-muted">
            They'll receive an email with a sign-in link. Inviting someone who already has an
            account links it to this store immediately.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor={emailId}>Email</Label>
          <div className="relative">
            <Mail
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            />
            <Input
              id={emailId}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              placeholder="teammate@store.com"
              required
              disabled={busy}
              className="pl-9"
              aria-invalid={error !== null ? 'true' : undefined}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={roleId}>Role</Label>
          <select
            id={roleId}
            value={role}
            onChange={(e) => {
              setRole(e.target.value as VendorStaffRole);
            }}
            disabled={busy}
            className="h-10 w-full rounded-lg border border-outline bg-surface px-3 text-sm text-foreground focus:border-moss-500 focus:outline-none focus:ring-4 focus:ring-moss-500/15 disabled:cursor-not-allowed disabled:bg-surface-muted"
          >
            {availableRoles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={busy} className="sm:self-end">
          {busy ? (
            <>
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Sending…
            </>
          ) : (
            'Send invite'
          )}
        </Button>
      </div>

      <p className="text-xs text-muted">{roleBlurb(role)}</p>

      {error !== null ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
      {success !== null ? (
        <p role="status" className="text-sm font-medium text-moss-700">
          {success}
        </p>
      ) : null}
    </form>
  );
}

function extractInviteError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return 'That person already has access to this store.';
    }
    if (err.status === 403) {
      return "You don't have permission to assign that role.";
    }
    if (err.status === 422) {
      return err.envelope?.error.message ?? 'That request was rejected. Check the email and role.';
    }
  }
  return "Couldn't send the invite. Try again — if it keeps failing, ping DankDash support.";
}
