import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TopProductsList } from './top-products-list.js';

describe('TopProductsList', () => {
  it('renders the empty-window placeholder when no products', () => {
    render(<TopProductsList products={[]} />);
    expect(screen.getByText(/No sales in this window/i)).toBeInTheDocument();
  });

  it('renders one entry per product, sorted as received', () => {
    render(
      <TopProductsList
        products={[
          {
            productId: 'p-1',
            brand: 'North Star',
            name: 'Pineapple Express',
            unitsSold: 12,
            revenueCents: 54_000,
          },
          {
            productId: 'p-2',
            brand: 'Goodfellas',
            name: 'OG Kush',
            unitsSold: 8,
            revenueCents: 24_000,
          },
        ]}
      />,
    );
    expect(screen.getByText(/North Star — Pineapple Express/)).toBeInTheDocument();
    expect(screen.getByText(/Goodfellas — OG Kush/)).toBeInTheDocument();
    expect(screen.getByText('$540.00')).toBeInTheDocument();
    expect(screen.getByText('$240.00')).toBeInTheDocument();
    expect(screen.getByText(/12 units/)).toBeInTheDocument();
    expect(screen.getByText(/8 units/)).toBeInTheDocument();
  });

  it('respects the limit prop', () => {
    render(
      <TopProductsList
        limit={1}
        products={[
          {
            productId: 'p-1',
            brand: 'North Star',
            name: 'Pineapple Express',
            unitsSold: 12,
            revenueCents: 54_000,
          },
          {
            productId: 'p-2',
            brand: 'Goodfellas',
            name: 'OG Kush',
            unitsSold: 8,
            revenueCents: 24_000,
          },
        ]}
      />,
    );
    expect(screen.getByText(/North Star — Pineapple Express/)).toBeInTheDocument();
    expect(screen.queryByText(/Goodfellas — OG Kush/)).not.toBeInTheDocument();
  });

  it('uses singular "unit" when unitsSold is 1', () => {
    render(
      <TopProductsList
        products={[
          {
            productId: 'p-1',
            brand: 'X',
            name: 'Y',
            unitsSold: 1,
            revenueCents: 1_000,
          },
        ]}
      />,
    );
    expect(screen.getByText('1 unit')).toBeInTheDocument();
  });
});
