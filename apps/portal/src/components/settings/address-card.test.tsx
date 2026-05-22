import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AddressCard } from './address-card.js';

const POLYGON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-93.3, 44.95],
      [-93.2, 44.95],
      [-93.2, 45.0],
      [-93.3, 45.0],
      [-93.3, 44.95],
    ],
  ] as readonly (readonly (readonly [number, number])[])[],
};

describe('AddressCard', () => {
  it('renders the address and coordinates', () => {
    render(
      <AddressCard
        addressLine1="1 Main St"
        addressLine2={null}
        city="Minneapolis"
        region="MN"
        postalCode="55401"
        location={{ type: 'Point', coordinates: [-93.265, 44.978] }}
        deliveryPolygon={POLYGON}
      />,
    );
    expect(screen.getByText('1 Main St')).toBeInTheDocument();
    expect(screen.getByText(/Minneapolis, MN 55401/u)).toBeInTheDocument();
    expect(screen.getByText(/44\.97800, -93\.26500/u)).toBeInTheDocument();
  });

  it('reports the polygon vertex count, excluding the closing duplicate', () => {
    render(
      <AddressCard
        addressLine1="1 Main St"
        addressLine2={null}
        city="Minneapolis"
        region="MN"
        postalCode="55401"
        location={{ type: 'Point', coordinates: [-93.265, 44.978] }}
        deliveryPolygon={POLYGON}
      />,
    );
    expect(screen.getByText(/4 vertices/u)).toBeInTheDocument();
  });

  it('renders an optional second address line', () => {
    render(
      <AddressCard
        addressLine1="1 Main St"
        addressLine2="Suite 200"
        city="Minneapolis"
        region="MN"
        postalCode="55401"
        location={{ type: 'Point', coordinates: [-93.265, 44.978] }}
        deliveryPolygon={POLYGON}
      />,
    );
    expect(screen.getByText('Suite 200')).toBeInTheDocument();
  });
});
