import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeadInventoryTable } from './dead-inventory-table.js';

describe('DeadInventoryTable', () => {
  it('renders the empty placeholder when nothing is dead', () => {
    render(<DeadInventoryTable rows={[]} />);
    expect(screen.getByText(/Nothing's gathering dust/i)).toBeInTheDocument();
  });

  it('renders one row per dead listing with sku, on-hand, price, and last-sale label', () => {
    render(
      <DeadInventoryTable
        rows={[
          {
            listingId: 'l-1',
            sku: 'NS-PE-3.5G',
            brand: 'North Star',
            name: 'Pineapple Express',
            quantityAvailable: 8,
            priceCents: 4500,
            daysSinceLastSale: 12,
          },
          {
            listingId: 'l-2',
            sku: 'GF-OG-1G',
            brand: 'Goodfellas',
            name: 'OG Kush',
            quantityAvailable: 2,
            priceCents: 1500,
            daysSinceLastSale: null,
          },
        ]}
      />,
    );
    expect(screen.getByText('NS-PE-3.5G')).toBeInTheDocument();
    expect(screen.getByText('GF-OG-1G')).toBeInTheDocument();
    expect(screen.getByText('$45.00')).toBeInTheDocument();
    expect(screen.getByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText('12 days ago')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });
});
