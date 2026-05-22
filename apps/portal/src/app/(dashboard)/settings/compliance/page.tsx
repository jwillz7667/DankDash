import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/card.js';

export const metadata: Metadata = {
  title: 'Compliance — DankDash for Business',
};

export default function ComplianceSettingsPage(): ReactNode {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Compliance</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm leading-relaxed text-slate-600">
        <p>
          MN cannabis posture: license expiry, ID-scan failure rate, Metrc reconciliation health,
          and the most recent audit log.
        </p>
        <p>
          The per-transaction limits (56.7g flower, 8g concentrate, 800mg edible THC) are
          server-enforced; this surface surfaces violations and operator overrides.
        </p>
      </CardBody>
    </Card>
  );
}
