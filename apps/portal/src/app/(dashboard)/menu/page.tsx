import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { MenuTable } from '../../../components/menu/menu-table.js';
import { Card, CardBody } from '../../../components/ui/card.js';
import { buildServerApiClient } from '../../../lib/api/server-client.js';
import {
  listVendorListings,
  type VendorListingWithProduct,
} from '../../../lib/api/vendor-listings.js';
import {
  deleteVendorListingAction,
  listVendorListingsAction,
  patchVendorListingAction,
  triggerVendorListingsSyncAction,
} from '../../../lib/listings/actions.js';
import { type VendorListingActions } from '../../../lib/listings/listing-actions.js';

export const metadata: Metadata = {
  title: 'Menu — DankDash for Business',
};

/**
 * Vendor menu page. Server component — fetches the initial listings
 * snapshot synchronously, then hands the rows to the client `MenuTable`
 * for inline edits + the manual POS sync.
 *
 * Cache disabled (`force-dynamic`) — pricing and inventory must never
 * serve a stale Next.js cache hit. The vendor refreshes after a sync
 * by re-fetching via the `list` server action.
 */
export const dynamic = 'force-dynamic';

export default async function MenuPage(): Promise<ReactNode> {
  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    return <NoDispensaryContext />;
  }

  let initialListings: readonly VendorListingWithProduct[];
  try {
    const result = await listVendorListings(ctx.client);
    initialListings = result.listings;
  } catch (error) {
    return <MenuFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  const actions: VendorListingActions = {
    list: listVendorListingsAction,
    patch: patchVendorListingAction,
    remove: deleteVendorListingAction,
    sync: triggerVendorListingsSyncAction,
  };

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="text-2xs font-semibold uppercase tracking-wider text-moss-600">
            {ctx.dispensary.name}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Menu</h1>
          <p className="max-w-2xl text-sm text-muted">
            Listings, pricing, inventory, and POS reconciliation. Inline edits commit immediately;
            the public menu picks up the change as the catalog cache cycles.
          </p>
        </div>
      </header>
      <MenuTable initialListings={initialListings} actions={actions} />
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
            Your account isn't yet linked to an active dispensary. Accept your invitation or contact
            your owner to grant access — the menu will appear here once a membership is active.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function MenuFetchError({
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
            Couldn't load the menu
          </h2>
          <p className="text-sm text-muted">
            The menu for {storeName} didn't load. Refresh the page; if this keeps happening, ping
            DankDash support.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
