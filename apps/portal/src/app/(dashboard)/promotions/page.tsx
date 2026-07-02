import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { PromotionsClient } from '../../../components/promotions/promotions-client.js';
import { Card, CardBody } from '../../../components/ui/card.js';
import { buildServerApiClient } from '../../../lib/api/server-client.js';
import { listVendorPromotions, type VendorPromotion } from '../../../lib/api/vendor-promotions.js';
import {
  createVendorPromotionAction,
  deactivateVendorPromotionAction,
  listVendorPromotionsAction,
  patchVendorPromotionAction,
} from '../../../lib/promotions/actions.js';
import type { VendorPromotionActions } from '../../../lib/promotions/promotion-actions.js';

export const metadata: Metadata = {
  title: 'Promotions — DankDash for Business',
};

/**
 * Promotions page (manager+). Server-renders the store's promo codes off a
 * single `GET /v1/vendor/promotions` call, then hands them to a client
 * orchestrator for create/deactivate/reactivate.
 *
 * `force-dynamic` because the data is per-vendor (X-Dispensary-Id is
 * session-scoped) and must not be cached across principals.
 *
 * Budtenders are filtered upstream by the sidebar role gate and the API's
 * `@Roles('manager', 'owner', 'admin', 'superadmin')` guard. A budtender who
 * navigates directly here gets redirected to /dashboard; if they bypass that,
 * the API returns 403 and the fetch-error state renders.
 */
export const dynamic = 'force-dynamic';

export default async function PromotionsPage(): Promise<ReactNode> {
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

  let initialPromotions: readonly VendorPromotion[];
  try {
    const result = await listVendorPromotions(ctx.client);
    initialPromotions = result.promotions;
  } catch (error) {
    return <PromotionsFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  const actions: VendorPromotionActions = {
    list: listVendorPromotionsAction,
    create: createVendorPromotionAction,
    patch: patchVendorPromotionAction,
    deactivate: deactivateVendorPromotionAction,
  };

  return <PromotionsClient initialPromotions={initialPromotions} actions={actions} />;
}

function NoDispensaryContext(): ReactNode {
  return (
    <Card>
      <CardBody className="space-y-3 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-warning-soft text-warning">
          <AlertTriangle aria-hidden="true" className="h-5 w-5" />
        </div>
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          No dispensary context
        </h2>
        <p className="text-sm text-muted">
          Promotions are scoped to an active dispensary. Accept your invitation or contact your
          owner to grant access.
        </p>
      </CardBody>
    </Card>
  );
}

function PromotionsFetchError({
  storeName,
  error,
}: {
  readonly storeName: string;
  readonly error: unknown;
}): ReactNode {
  void error;
  return (
    <Card>
      <CardBody className="space-y-3 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
          <AlertTriangle aria-hidden="true" className="h-5 w-5" />
        </div>
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          Couldn't load promotions
        </h2>
        <p className="text-sm text-muted">
          We couldn't load promo codes for {storeName}. Refresh; if it keeps failing, ping DankDash
          support.
        </p>
      </CardBody>
    </Card>
  );
}
