import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviewForm } from './review-form.js';

function noop(): void {
  /* server action stand-in */
}

describe('ReviewForm', () => {
  it('renders tip presets with $5.00 selected by default and the running total', () => {
    render(<ReviewForm subtotalCents={2000} promoCode={null} discountCents={0} action={noop} />);
    // Four presets.
    expect(screen.getByRole('button', { name: '$3.00' })).toBeInTheDocument();
    const five = screen.getByRole('button', { name: '$5.00' });
    expect(five).toHaveAttribute('aria-pressed', 'true');
    // Submit shows subtotal ($20) + default tip ($5) = $25.00.
    expect(screen.getByRole('button', { name: /Place order · \$25\.00/ })).toBeInTheDocument();
  });

  it('renders a discount line with the code and subtracts it from the total', () => {
    // $20 subtotal, $5 off (SAVE5), default $5 tip → $20 - $5 + $5 = $20.00.
    render(<ReviewForm subtotalCents={2000} promoCode="SAVE5" discountCents={500} action={noop} />);
    expect(screen.getByText('Discount (SAVE5)')).toBeInTheDocument();
    expect(screen.getByText('−$5.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Place order · \$20\.00/ })).toBeInTheDocument();
  });

  it('omits the discount line when there is no discount', () => {
    render(<ReviewForm subtotalCents={2000} promoCode={null} discountCents={0} action={noop} />);
    expect(screen.queryByText(/Discount/)).not.toBeInTheDocument();
  });

  it('updates the hidden tip field and total when a preset is chosen', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ReviewForm subtotalCents={2000} promoCode={null} discountCents={0} action={noop} />,
    );

    await user.click(screen.getByRole('button', { name: '$10.00' }));

    const hidden = container.querySelector<HTMLInputElement>('input[name="driverTipCents"]');
    expect(hidden?.value).toBe('1000');
    expect(screen.getByRole('button', { name: '$10.00' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Place order · \$30\.00/ })).toBeInTheDocument();
  });

  it('clamps a custom tip below the $2 floor up to the floor', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ReviewForm subtotalCents={1000} promoCode={null} discountCents={0} action={noop} />,
    );

    await user.type(screen.getByLabelText(/Custom tip/i), '1');

    const hidden = container.querySelector<HTMLInputElement>('input[name="driverTipCents"]');
    expect(hidden?.value).toBe('200');
  });

  it('exposes a delivery-instructions field bound to the form', () => {
    render(<ReviewForm subtotalCents={1000} promoCode={null} discountCents={0} action={vi.fn()} />);
    const textarea = screen.getByLabelText(/Delivery instructions/i);
    expect(textarea).toHaveAttribute('name', 'deliveryInstructions');
  });
});
