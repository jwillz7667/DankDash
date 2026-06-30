'use client';

/**
 * Client orchestrator for the Products page. Owns the local product list so
 * create/edit/delete update the table without a refetch, and drives the
 * ProductEditor slide-over for both "new" and "edit".
 *
 * Actions are injected (VendorProductActions) so tests run with in-memory
 * fakes — mirrors the menu/settings client pattern.
 */
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { listingImageUrl } from '../../lib/listings/images.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardBody } from '../ui/card.js';
import { ProductEditor } from './product-editor.js';
import type { ProductCategory, VendorProduct } from '../../lib/api/vendor-products.js';
import type { VendorProductActions } from '../../lib/products/product-actions.js';

export interface ProductsClientProps {
  readonly initialProducts: readonly VendorProduct[];
  readonly categories: readonly ProductCategory[];
  readonly actions: VendorProductActions;
  readonly imageBaseUrl?: string;
}

type EditorTarget = { readonly mode: 'create' } | { readonly mode: 'edit'; readonly product: VendorProduct };

export function ProductsClient({
  initialProducts,
  categories,
  actions,
  imageBaseUrl,
}: ProductsClientProps): ReactNode {
  const [products, setProducts] = useState<readonly VendorProduct[]>(initialProducts);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSaved = useCallback((saved: VendorProduct): void => {
    setProducts((prev) => {
      const idx = prev.findIndex((p) => p.id === saved.id);
      if (idx === -1) return [saved, ...prev];
      const next = [...prev];
      next[idx] = saved;
      return next;
    });
  }, []);

  const handleDelete = useCallback(
    async (product: VendorProduct): Promise<void> => {
      setRemovingId(product.id);
      setError(null);
      try {
        await actions.remove(product.id);
        setProducts((prev) => prev.filter((p) => p.id !== product.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete that product.");
      } finally {
        setRemovingId(null);
      }
    },
    [actions],
  );

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Products</h1>
          <p className="max-w-2xl text-sm text-muted">
            Author and edit your own products — name, potency, photos, and more. Stock them on your
            menu from the Menu page.
          </p>
        </div>
        <Button onClick={() => { setEditor({ mode: 'create' }); }} data-testid="products-new">
          <Plus aria-hidden="true" className="h-4 w-4" />
          New product
        </Button>
      </header>

      {error !== null ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {products.length === 0 ? (
        <Card>
          <CardBody className="space-y-2 py-12 text-center">
            <p className="text-base font-semibold text-foreground">No products yet</p>
            <p className="text-sm text-muted">
              Create your first product to start building your own catalog.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="p-0">
            <ul className="divide-y divide-outline-subtle" data-testid="products-list">
              {products.map((product) => {
                const url =
                  product.imageKeys.length > 0
                    ? listingImageUrl(product.imageKeys[0] ?? '', imageBaseUrl)
                    : null;
                return (
                  <li key={product.id} className="flex items-center gap-4 px-5 py-3">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-outline bg-surface-subtle">
                      {url !== null ? (
                        <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {product.brand} — {product.name}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {product.productType.replace(/_/gu, ' ')} · {product.thcMgPerUnit} mg THC
                      </p>
                    </div>
                    <Badge tone="neutral">{product.imageKeys.length} photo{product.imageKeys.length === 1 ? '' : 's'}</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setEditor({ mode: 'edit', product }); }}
                      data-testid={`products-edit-${product.id}`}
                    >
                      <Pencil aria-hidden="true" className="h-4 w-4" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={removingId === product.id}
                      onClick={() => {
                        void handleDelete(product);
                      }}
                      aria-label={`Delete ${product.name}`}
                    >
                      {removingId === product.id ? (
                        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}

      {editor !== null ? (
        <ProductEditor
          product={editor.mode === 'edit' ? editor.product : null}
          categories={categories}
          onClose={() => { setEditor(null); }}
          onSaved={handleSaved}
          actions={actions}
          imageBaseUrl={imageBaseUrl}
        />
      ) : null}
    </div>
  );
}
