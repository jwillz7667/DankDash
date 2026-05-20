import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReorderRateCard } from './reorder-rate-card.js';

describe('ReorderRateCard', () => {
  it('renders the percent and X-of-Y breakdown', () => {
    render(
      <ReorderRateCard
        reorderRate={{ customerCount: 600, repeatCustomerCount: 193, rate: 0.3217 }}
      />,
    );
    expect(screen.getByText('32.2%')).toBeInTheDocument();
    expect(screen.getByText('193 of 600 customers reordered')).toBeInTheDocument();
  });

  it('renders "—" when no customers ordered in the window', () => {
    render(<ReorderRateCard reorderRate={{ customerCount: 0, repeatCustomerCount: 0, rate: 0 }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/No delivered orders/i)).toBeInTheDocument();
  });
});
