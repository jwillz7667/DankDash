import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntegrationsCard } from './integrations-card.js';

describe('IntegrationsCard', () => {
  it('marks manual POS as connected and explains it', () => {
    render(
      <IntegrationsCard
        posProvider="manual"
        posLastSyncedAt={null}
        hasPosCredentials={false}
        metrcFacilityId={null}
        hasMetrcCredentials={false}
        hasAeropayAccount={false}
      />,
    );
    expect(screen.getByText(/POS — Manual/i)).toBeInTheDocument();
    expect(screen.getByText(/inventory is managed manually/i)).toBeInTheDocument();
  });

  it('marks Dutchie disconnected when credentials are missing', () => {
    render(
      <IntegrationsCard
        posProvider="dutchie"
        posLastSyncedAt={null}
        hasPosCredentials={false}
        metrcFacilityId={null}
        hasMetrcCredentials={false}
        hasAeropayAccount={false}
      />,
    );
    expect(screen.getByText(/POS — Dutchie/i)).toBeInTheDocument();
  });

  it('marks Metrc connected when both creds and facility id are present', () => {
    render(
      <IntegrationsCard
        posProvider="manual"
        posLastSyncedAt={null}
        hasPosCredentials={false}
        metrcFacilityId="FAC-123"
        hasMetrcCredentials={true}
        hasAeropayAccount={false}
      />,
    );
    expect(screen.getByText(/Facility FAC-123/i)).toBeInTheDocument();
  });

  it('marks Aeropay connected when the account is linked', () => {
    const { container } = render(
      <IntegrationsCard
        posProvider="manual"
        posLastSyncedAt={null}
        hasPosCredentials={false}
        metrcFacilityId={null}
        hasMetrcCredentials={false}
        hasAeropayAccount={true}
      />,
    );
    const aeropayHeading = within(container).getByText(/^Aeropay$/i);
    const row = aeropayHeading.closest('div')?.parentElement ?? null;
    expect(row).not.toBeNull();
    expect(within(row!).getByText(/Connected/i)).toBeInTheDocument();
  });
});
