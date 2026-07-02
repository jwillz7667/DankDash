import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromotionEditor } from './promotion-editor.js';
import type {
  CreateVendorPromotionInput,
  VendorPromotion,
} from '../../lib/api/vendor-promotions.js';

const NOW = new Date(2026, 6, 2, 14, 30, 0, 0);
const NOW_ISO = NOW.toISOString();

function makePromotion(input: CreateVendorPromotionInput): VendorPromotion {
  return {
    id: '01935f3d-0000-7000-8000-000000000001',
    code: input.code,
    type: input.type,
    value: input.value,
    scope: 'dispensary',
    dispensaryId: '01935f3d-0000-7000-8000-0000000000aa',
    minSubtotalCents: input.minSubtotalCents ?? 0,
    maxDiscountCents: input.maxDiscountCents ?? null,
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? null,
    maxRedemptions: input.maxRedemptions ?? null,
    maxRedemptionsPerUser: input.maxRedemptionsPerUser ?? 1,
    active: true,
    redemptionCount: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

function makeActions(create = vi.fn(async (i: CreateVendorPromotionInput) => makePromotion(i))): {
  create: typeof create;
} {
  return { create };
}

describe('PromotionEditor', () => {
  it('submits a percent promo with the seeded start time and parsed caps', async () => {
    const actions = makeActions();
    const onCreated = vi.fn();
    render(<PromotionEditor onClose={vi.fn()} onCreated={onCreated} actions={actions} now={NOW} />);

    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'summer-10' } });
    fireEvent.change(screen.getByLabelText('Percent off (%)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Max discount ($, optional)'), {
      target: { value: '20.00' },
    });
    fireEvent.change(screen.getByLabelText('Minimum subtotal ($, optional)'), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByTestId('promotion-editor-save'));

    await waitFor(() => {
      expect(actions.create).toHaveBeenCalledTimes(1);
    });
    const payload = actions.create.mock.calls[0]?.[0];
    expect(payload).toEqual({
      code: 'SUMMER-10',
      type: 'percent',
      value: 10,
      minSubtotalCents: 2500,
      maxDiscountCents: 2000,
      startsAt: NOW_ISO,
      endsAt: null,
      maxRedemptions: null,
      maxRedemptionsPerUser: 1,
    });
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it('converts a fixed-amount dollar entry to integer cents and omits the percent cap', async () => {
    const actions = makeActions();
    render(<PromotionEditor onClose={vi.fn()} onCreated={vi.fn()} actions={actions} now={NOW} />);

    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'FIVEOFF' } });
    fireEvent.change(screen.getByTestId('promotion-editor-type'), {
      target: { value: 'fixed_amount' },
    });
    fireEvent.change(screen.getByLabelText('Amount off ($)'), { target: { value: '5.00' } });
    fireEvent.click(screen.getByTestId('promotion-editor-save'));

    await waitFor(() => {
      expect(actions.create).toHaveBeenCalledTimes(1);
    });
    const payload = actions.create.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ type: 'fixed_amount', value: 500 });
    expect(payload).not.toHaveProperty('maxDiscountCents');
  });

  it('sends value 0 for a free-delivery promo', async () => {
    const actions = makeActions();
    render(<PromotionEditor onClose={vi.fn()} onCreated={vi.fn()} actions={actions} now={NOW} />);

    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'FREESHIP' } });
    fireEvent.change(screen.getByTestId('promotion-editor-type'), {
      target: { value: 'free_delivery' },
    });
    fireEvent.click(screen.getByTestId('promotion-editor-save'));

    await waitFor(() => {
      expect(actions.create).toHaveBeenCalledTimes(1);
    });
    expect(actions.create.mock.calls[0]?.[0]).toMatchObject({
      type: 'free_delivery',
      value: 0,
    });
  });

  it('blocks an invalid code without calling the API', async () => {
    const actions = makeActions();
    render(<PromotionEditor onClose={vi.fn()} onCreated={vi.fn()} actions={actions} now={NOW} />);

    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'AB' } });
    fireEvent.change(screen.getByLabelText('Percent off (%)'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('promotion-editor-save'));

    expect(await screen.findByTestId('promotion-editor-error')).toHaveTextContent(
      /Code must be 3–40 characters/i,
    );
    expect(actions.create).not.toHaveBeenCalled();
  });

  it('blocks a percent outside 1..100', async () => {
    const actions = makeActions();
    render(<PromotionEditor onClose={vi.fn()} onCreated={vi.fn()} actions={actions} now={NOW} />);

    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'BIG' } });
    fireEvent.change(screen.getByLabelText('Percent off (%)'), { target: { value: '150' } });
    fireEvent.click(screen.getByTestId('promotion-editor-save'));

    expect(await screen.findByTestId('promotion-editor-error')).toHaveTextContent(
      /whole number from 1 to 100/i,
    );
    expect(actions.create).not.toHaveBeenCalled();
  });
});
