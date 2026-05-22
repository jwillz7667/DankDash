import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { AddressCard } from '../../../../components/settings/address-card.js';
import { LicenseCard } from '../../../../components/settings/license-card.js';
import { Card, CardBody } from '../../../../components/ui/card.js';
import { buildServerApiClient } from '../../../../lib/api/server-client.js';
import { getVendorSettings, type VendorSettings } from '../../../../lib/api/vendor-settings.js';

export const metadata: Metadata = {
  title: 'Compliance — DankDash for Business',
};

export const dynamic = 'force-dynamic';

export default async function ComplianceSettingsPage(): Promise<ReactNode> {
  const ctx = await buildServerApiClient();
  if (ctx === null) {
    redirect('/login');
  }
  if (ctx.dispensary === null) {
    return <NoDispensaryContext />;
  }

  let settings: VendorSettings;
  try {
    settings = await getVendorSettings(ctx.client);
  } catch (error) {
    return <SettingsFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <LicenseCard
        licenseNumber={settings.licenseNumber}
        licenseType={settings.licenseType}
        licenseIssuedAt={settings.licenseIssuedAt}
        licenseExpiresAt={settings.licenseExpiresAt}
      />
      <AddressCard
        addressLine1={settings.addressLine1}
        addressLine2={settings.addressLine2}
        city={settings.city}
        region={settings.region}
        postalCode={settings.postalCode}
        location={settings.location}
        deliveryPolygon={settings.deliveryPolygon}
      />
    </div>
  );
}

function NoDispensaryContext(): ReactNode {
  return (
    <Card>
      <CardBody className="space-y-3 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-700">
          <AlertTriangle aria-hidden="true" className="h-5 w-5" />
        </div>
        <h2 className="text-base font-semibold tracking-tight text-slate-900">
          No dispensary context
        </h2>
        <p className="text-sm text-slate-500">
          Compliance settings are scoped to an active dispensary. Accept your invitation or contact
          your owner to grant access.
        </p>
      </CardBody>
    </Card>
  );
}

function SettingsFetchError({
  storeName,
  error,
}: {
  readonly storeName: string;
  readonly error: unknown;
}): ReactNode {
  void error;
  return (
    <Card>
      <CardBody className="space-y-3 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-700">
          <AlertTriangle aria-hidden="true" className="h-5 w-5" />
        </div>
        <h2 className="text-base font-semibold tracking-tight text-slate-900">
          Couldn't load compliance posture
        </h2>
        <p className="text-sm text-slate-500">
          We couldn't load compliance info for {storeName}. Refresh the page; if it keeps failing,
          ping DankDash support.
        </p>
      </CardBody>
    </Card>
  );
}
