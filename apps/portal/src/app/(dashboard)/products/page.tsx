import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { auth } from '../../../auth.js';
import { ProductsClient } from '../../../components/products/products-client.js';
import { Card, CardBody } from '../../../components/ui/card.js';
import { buildServerApiClient } from '../../../lib/api/server-client.js';
import {
  listProductCategories,
  listVendorProducts,
  type ProductCategory,
  type VendorProduct,
} from '../../../lib/api/vendor-products.js';
import { loadPublicEnv } from '../../../lib/env.js';
import {
  createVendorProductAction,
  deleteVendorProductAction,
  listVendorProductsAction,
  patchVendorProductAction,
  requestProductImageUploadAction,
} from '../../../lib/products/actions.js';
import type { VendorProductActions } from '../../../lib/products/product-actions.js';

export const metadata: Metadata = {
  title: 'Products — DankDash for Business',
};

/**
 * Products page — a dispensary authors and manages its OWN catalog products
 * (every field), distinct from the admin-owned global catalog. Open to every
 * vendor role (budtender+); the server still enforces all compliance limits
 * (potency caps, beverage rules, image ownership) regardless of role. Stocking
 * a product onto the menu happens from the Menu page.
 */
export const dynamic = 'force-dynamic';

export default async function ProductsPage(): Promise<ReactNode> {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }

  const ctx = await buildServerApiClient();
  if (ctx?.dispensary == null) {
    return <NoDispensaryContext />;
  }

  let initialProducts: readonly VendorProduct[];
  let categories: readonly ProductCategory[];
  try {
    const [productsResult, categoriesResult] = await Promise.all([
      listVendorProducts(ctx.client),
      listProductCategories(ctx.client),
    ]);
    initialProducts = productsResult.products;
    categories = categoriesResult;
  } catch (error) {
    return <ProductsFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  const actions: VendorProductActions = {
    list: listVendorProductsAction,
    create: createVendorProductAction,
    patch: patchVendorProductAction,
    remove: deleteVendorProductAction,
    requestImageUpload: requestProductImageUploadAction,
  };

  const imageBaseUrl = loadPublicEnv().NEXT_PUBLIC_R2_PUBLIC_BASE_URL;

  return (
    <ProductsClient
      initialProducts={initialProducts}
      categories={categories}
      actions={actions}
      imageBaseUrl={imageBaseUrl}
    />
  );
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
          Products are scoped to an active dispensary. Accept your invitation or contact your owner
          to grant access.
        </p>
      </CardBody>
    </Card>
  );
}

function ProductsFetchError({
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
          Couldn't load products
        </h2>
        <p className="text-sm text-muted">
          We couldn't load products for {storeName}. Refresh; if it keeps failing, ping DankDash
          support.
        </p>
      </CardBody>
    </Card>
  );
}
