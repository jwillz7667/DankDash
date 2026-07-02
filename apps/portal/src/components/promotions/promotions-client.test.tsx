import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromotionsClient } from './promotions-client.js';
import type { VendorPromotion } from '../../lib/api/vendor-promotions.js';
import type { VendorPromotionActions } from '../../lib/promotions/promotion-actions.js';

function makePromotion(overrides: Partial<VendorPromotion> = {}): VendorPromotion {
  return {
    id: '01935f3d-0000-7000-8000-000000000001',
    code: 'SUMMER10',
    type: 'percent',
    value: 10,
    scope: 'dispensary',
    dispensaryId: '01935f3d-0000-7000-8000-0000000000aa',
    minSubtotalCents: 2500,
    maxDiscountCents: 2000,
    startsAt: '2026-07-02T18:30:00.000Z',
    endsAt: null,
    maxRedemptions: 100,
    maxRedemptionsPerUser: 1,
    active: true,
    redemptionCount: 12,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeActions(overrides: Partial<VendorPromotionActions> = {}): VendorPromotionActions {
  return {
    list: vi.fn(async () => []),
    create: vi.fn(async () => makePromotion()),
    patch: vi.fn(async () => makePromotion()),
    deactivate: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('PromotionsClient', () => {
  it('renders the empty state when there are no promos', () => {
    render(<PromotionsClient initialPromotions={[]} actions={makeActions()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/No promo codes yet/i);
  });

  it('renders a promo row with humanized value, redemptions, and status', () => {
    render(<PromotionsClient initialPromotions={[makePromotion()]} actions={makeActions()} />);
    const row = screen.getByTestId('promotions-row-01935f3d-0000-7000-8000-000000000001');
    expect(within(row).getByText('SUMMER10')).toBeInTheDocument();
    expect(within(row).getByText('10% off')).toBeInTheDocument();
    expect(within(row).getByText('$25.00')).toBeInTheDocument();
    expect(within(row).getByText('12 / 100')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
  });

  it('deactivates an active promo and flips its status without a refetch', async () => {
    const deactivate = vi.fn(async () => undefined);
    render(
      <PromotionsClient
        initialPromotions={[makePromotion()]}
        actions={makeActions({ deactivate })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate SUMMER10' }));

    await waitFor(() => {
      expect(deactivate).toHaveBeenCalledWith('01935f3d-0000-7000-8000-000000000001');
    });
    expect(await screen.findByRole('button', { name: 'Reactivate SUMMER10' })).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('reactivates an inactive promo via patch', async () => {
    const patch = vi.fn(async () => makePromotion({ active: true }));
    render(
      <PromotionsClient
        initialPromotions={[makePromotion({ active: false })]}
        actions={makeActions({ patch })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reactivate SUMMER10' }));

    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith('01935f3d-0000-7000-8000-000000000001', { active: true });
    });
    expect(await screen.findByText('Active')).toBeInTheDocument();
  });

  it('surfaces the API error message when a deactivation fails', async () => {
    const deactivate = vi.fn(async () => {
      throw new Error('Promo code is referenced by an in-flight order.');
    });
    render(
      <PromotionsClient
        initialPromotions={[makePromotion()]}
        actions={makeActions({ deactivate })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate SUMMER10' }));

    expect(await screen.findByTestId('promotions-error')).toHaveTextContent(
      /referenced by an in-flight order/i,
    );
  });

  it('opens the create editor from the New button', () => {
    render(<PromotionsClient initialPromotions={[]} actions={makeActions()} />);
    expect(screen.queryByTestId('promotion-editor')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('promotions-new'));

    expect(screen.getByTestId('promotion-editor')).toBeInTheDocument();
  });
});
