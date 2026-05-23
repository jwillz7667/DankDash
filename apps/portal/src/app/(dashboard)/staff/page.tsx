import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { StaffListTable } from '../../../components/staff/staff-list-table.js';
import { Card, CardBody } from '../../../components/ui/card.js';
import { buildServerApiClient } from '../../../lib/api/server-client.js';
import { listVendorStaff, type VendorStaffMember } from '../../../lib/api/vendor-staff.js';
import {
  inviteVendorStaffAction,
  listVendorStaffAction,
  patchVendorStaffRoleAction,
  removeVendorStaffAction,
} from '../../../lib/staff/actions.js';
import type { VendorStaffActions } from '../../../lib/staff/staff-actions.js';

export const metadata: Metadata = {
  title: 'Staff — DankDash for Business',
};

/**
 * Vendor staff page (Phase 15.4). Server-renders the roster off a
 * single `GET /v1/vendor/staff` call, hands the snapshot to the client
 * table along with server-action proxies for mutations.
 *
 * `force-dynamic` because the data is per-vendor (X-Dispensary-Id is
 * session-scoped) and must not be cached across principals.
 *
 * Budtenders are filtered upstream by the sidebar role gate (Phase 13)
 * and the API's `@Roles('manager', 'owner', 'admin', 'superadmin')`
 * guard. A budtender who navigates here directly gets redirected to
 * /dashboard by the role check below; if they bypass that, the API
 * returns 403 and the error boundary kicks in.
 */
export const dynamic = 'force-dynamic';

export default async function StaffPage(): Promise<ReactNode> {
  const ctx = await buildServerApiClient();
  if (ctx === null) {
    redirect('/login');
  }
  if (ctx.dispensary === null) {
    return <NoDispensaryContext />;
  }
  if (ctx.dispensary.staffRole === 'budtender') {
    redirect('/dashboard');
  }

  let initialStaff: readonly VendorStaffMember[];
  try {
    const result = await listVendorStaff(ctx.client);
    initialStaff = result.staff;
  } catch (error) {
    return <StaffFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  const actions: VendorStaffActions = {
    list: listVendorStaffAction,
    invite: inviteVendorStaffAction,
    patchRole: patchVendorStaffRoleAction,
    remove: removeVendorStaffAction,
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="space-y-1.5">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Staff</h1>
        <p className="text-sm text-muted">
          Budtenders, managers, and owners attached to {ctx.dispensary.name}. Invite teammates by
          email and assign their access level here.
        </p>
      </header>
      <StaffListTable
        initialStaff={initialStaff}
        actions={actions}
        currentUserId={ctx.user.id}
        currentStaffRole={ctx.dispensary.staffRole}
      />
    </div>
  );
}

function NoDispensaryContext(): ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-12">
      <Card>
        <CardBody className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-warning-soft text-warning">
            <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          </div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            No dispensary context
          </h2>
          <p className="text-sm text-muted">
            The staff roster is scoped to an active dispensary. Accept your invitation or contact
            your owner to grant access.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function StaffFetchError({
  storeName,
  error,
}: {
  readonly storeName: string;
  readonly error: unknown;
}): ReactNode {
  void error;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-12">
      <Card>
        <CardBody className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          </div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Couldn't load the staff roster
          </h2>
          <p className="text-sm text-muted">
            We couldn't load staff for {storeName}. Refresh the page; if it keeps failing, ping
            DankDash support.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
