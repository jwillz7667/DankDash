import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '../../../../components/ui/card.js';

export const metadata: Metadata = {
  title: 'Store settings — DankDash for Business',
};

export default function StoreSettingsPage(): ReactNode {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Store</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm leading-relaxed text-slate-600">
        <p>
          Store hours, delivery polygon, contact details, and license numbers will be edited here.
        </p>
        <p>
          Compliance-sensitive fields (license expiry, MN ID) are read-only from this surface —
          updates flow through compliance review (Phase 19).
        </p>
      </CardBody>
    </Card>
  );
}
