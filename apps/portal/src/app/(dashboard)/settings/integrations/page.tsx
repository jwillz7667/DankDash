import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/card.js';

export const metadata: Metadata = {
  title: 'Integrations — DankDash for Business',
};

export default function IntegrationsSettingsPage(): ReactNode {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm leading-relaxed text-slate-600">
        <p>
          Stripe Connect status, Metrc package-tag sync, and Veriff identity-verification webhooks
          live here.
        </p>
        <p>
          Connection state is read from the API; this surface lights up in Phase 18 once Stripe
          onboarding ships.
        </p>
      </CardBody>
    </Card>
  );
}
