'use client';

/**
 * Client orchestrator for the "Store" settings sub-page. Owns the
 * local snapshot of `VendorSettings` so every successful PATCH (from
 * any of the child cards) updates the entire page consistently — e.g.
 * editing hours doesn't stale the brand card's preview.
 *
 * Server actions are passed in as the `actions` prop so tests can
 * inject in-memory fakes (mirrors the staff/menu/payouts pattern).
 */
import { useCallback, useState, type ReactNode } from 'react';
import { AcceptingOrdersCard } from './accepting-orders-card.js';
import { BrandCard } from './brand-card.js';
import { ContactCard } from './contact-card.js';
import { HoursEditor } from './hours-editor.js';
import type { VendorSettings } from '../../lib/api/vendor-settings.js';
import type { VendorSettingsActions } from '../../lib/settings/settings-actions.js';

export interface StoreSettingsClientProps {
  readonly initialSettings: VendorSettings;
  readonly actions: VendorSettingsActions;
}

export function StoreSettingsClient({
  initialSettings,
  actions,
}: StoreSettingsClientProps): ReactNode {
  const [settings, setSettings] = useState<VendorSettings>(initialSettings);

  const handlePatched = useCallback((next: VendorSettings): void => {
    setSettings(next);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <AcceptingOrdersCard
        isAcceptingOrders={settings.isAcceptingOrders}
        onPatch={actions.patch}
        onPatched={handlePatched}
      />
      <HoursEditor hours={settings.hours} onPatch={actions.patch} onPatched={handlePatched} />
      <ContactCard
        phone={settings.phone}
        email={settings.email}
        onPatch={actions.patch}
        onPatched={handlePatched}
      />
      <BrandCard
        brandColorHex={settings.brandColorHex}
        logoImageKey={settings.logoImageKey}
        heroImageKey={settings.heroImageKey}
        onPatch={actions.patch}
        onPatched={handlePatched}
      />
    </div>
  );
}
