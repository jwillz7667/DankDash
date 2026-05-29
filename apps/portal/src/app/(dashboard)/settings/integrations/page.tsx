import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { IntegrationsCard } from '../../../../components/settings/integrations-card.js';
import { Card, CardBody } from '../../../../components/ui/card.js';
import { buildServerApiClient } from '../../../../lib/api/server-client.js';
import { getVendorSettings, type VendorSettings } from '../../../../lib/api/vendor-settings.js';

export const metadata: Metadata = {
  title: 'Integrations — DankDash for Business',
};

export const dynamic = 'force-dynamic';

export default async function IntegrationsSettingsPage(): Promise<ReactNode> {
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
    <IntegrationsCard
      posProvider={settings.posProvider}
      posLastSyncedAt={settings.posLastSyncedAt}
      hasPosCredentials={settings.hasPosCredentials}
      metrcFacilityId={settings.metrcFacilityId}
      hasMetrcCredentials={settings.hasMetrcCredentials}
      hasAeropayAccount={settings.hasAeropayAccount}
    />
  );
}

function NoDispensaryContext(): ReactNode {
  return (
    <Card>
      <CardBody className="space-y-3 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-warning-soft text-warning">
          <AlertTriangle aria-hidden="true" className="h-5 w-5" />
        </div>
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          No dispensary context
        </h2>
        <p className="text-sm text-muted">
          Integrations are scoped to an active dispensary. Accept your invitation or contact your
          owner to grant access.
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
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
          <AlertTriangle aria-hidden="true" className="h-5 w-5" />
        </div>
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          Couldn't load integrations
        </h2>
        <p className="text-sm text-muted">
          We couldn't load integration status for {storeName}. Refresh the page; if it keeps
          failing, ping DankDash support.
        </p>
      </CardBody>
    </Card>
  );
}
