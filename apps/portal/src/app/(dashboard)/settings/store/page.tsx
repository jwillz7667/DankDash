import { AlertTriangle } from 'lucide-react';
import { type Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { StoreSettingsClient } from '../../../../components/settings/store-settings-client.js';
import { Card, CardBody } from '../../../../components/ui/card.js';
import { buildServerApiClient } from '../../../../lib/api/server-client.js';
import { getVendorSettings, type VendorSettings } from '../../../../lib/api/vendor-settings.js';
import {
  getVendorSettingsAction,
  patchVendorSettingsAction,
} from '../../../../lib/settings/actions.js';
import type { VendorSettingsActions } from '../../../../lib/settings/settings-actions.js';

export const metadata: Metadata = {
  title: 'Store settings — DankDash for Business',
};

/**
 * Store sub-page (Phase 15.5): hours, accepting toggle, contact,
 * brand. Reads the current settings snapshot once on the server then
 * hands the mutable cards down to a client orchestrator.
 *
 * The settings layout above us has already enforced the manager+ role
 * gate, so we don't repeat it here.
 */
export const dynamic = 'force-dynamic';

export default async function StoreSettingsPage(): Promise<ReactNode> {
  const ctx = await buildServerApiClient();
  if (ctx === null) {
    redirect('/login');
  }
  if (ctx.dispensary === null) {
    return <NoDispensaryContext />;
  }

  let initialSettings: VendorSettings;
  try {
    initialSettings = await getVendorSettings(ctx.client);
  } catch (error) {
    return <SettingsFetchError storeName={ctx.dispensary.name} error={error} />;
  }

  const actions: VendorSettingsActions = {
    get: getVendorSettingsAction,
    patch: patchVendorSettingsAction,
  };

  return <StoreSettingsClient initialSettings={initialSettings} actions={actions} />;
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
          Store settings are scoped to an active dispensary. Accept your invitation or contact your
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
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-700">
          <AlertTriangle aria-hidden="true" className="h-5 w-5" />
        </div>
        <h2 className="text-base font-semibold tracking-tight text-slate-900">
          Couldn't load settings
        </h2>
        <p className="text-sm text-slate-500">
          We couldn't load settings for {storeName}. Refresh the page; if it keeps failing, ping
          DankDash support.
        </p>
      </CardBody>
    </Card>
  );
}
