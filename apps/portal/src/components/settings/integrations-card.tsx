/**
 * Integration status — POS, Metrc, Aeropay. Read-only. The API
 * deliberately replaces the encrypted credential blobs with
 * `has*Credentials` booleans so the portal can render "Connected" or
 * "Not connected" without ever receiving the secret. Wiring up the
 * connection flows themselves is Phase 17 (POS sync) and Phase 18
 * (payments).
 */
import { CheckCircle2, CircleSlash, Layers, Link2, Wallet } from 'lucide-react';
import { type ReactNode } from 'react';
import { formatSyncTimestamp, posProviderLabel } from '../../lib/settings/format.js';
import { Badge, type BadgeTone } from '../ui/badge.js';
import { Card, CardBody, CardHeader, CardSubtitle, CardTitle } from '../ui/card.js';
import type { PosProvider } from '../../lib/api/vendor-settings.js';

export interface IntegrationsCardProps {
  readonly posProvider: PosProvider;
  readonly posLastSyncedAt: string | null;
  readonly hasPosCredentials: boolean;
  readonly metrcFacilityId: string | null;
  readonly hasMetrcCredentials: boolean;
  readonly hasAeropayAccount: boolean;
}

interface RowSpec {
  readonly icon: ReactNode;
  readonly title: string;
  readonly subtitle: string;
  readonly connected: boolean;
  /** Optional "since"/"last sync" line under the badge. */
  readonly footer?: ReactNode;
}

export function IntegrationsCard({
  posProvider,
  posLastSyncedAt,
  hasPosCredentials,
  metrcFacilityId,
  hasMetrcCredentials,
  hasAeropayAccount,
}: IntegrationsCardProps): ReactNode {
  const rows: readonly RowSpec[] = [
    {
      icon: <Layers aria-hidden="true" className="h-4 w-4" />,
      title: `POS — ${posProviderLabel(posProvider)}`,
      subtitle:
        posProvider === 'manual'
          ? 'No POS provider — inventory is managed manually.'
          : 'Hourly catalog sync from your POS into the menu.',
      connected: posProvider === 'manual' ? true : hasPosCredentials,
      footer:
        posProvider === 'manual' ? (
          <span className="text-xs text-slate-500">
            Switch providers from your account manager.
          </span>
        ) : (
          <span className="text-xs text-slate-500">
            Last sync: {formatSyncTimestamp(posLastSyncedAt)}
          </span>
        ),
    },
    {
      icon: <Link2 aria-hidden="true" className="h-4 w-4" />,
      title: 'Metrc',
      subtitle:
        'Cannabis track-and-trace receipts on every delivered order. Required for MN compliance.',
      connected: hasMetrcCredentials && metrcFacilityId !== null,
      footer:
        metrcFacilityId !== null ? (
          <span className="font-mono text-xs text-slate-500">Facility {metrcFacilityId}</span>
        ) : (
          <span className="text-xs text-slate-500">
            Configure your facility ID with your account manager.
          </span>
        ),
    },
    {
      icon: <Wallet aria-hidden="true" className="h-4 w-4" />,
      title: 'Aeropay',
      subtitle: 'Compliant cannabis payments rail. Required for payout settlement.',
      connected: hasAeropayAccount,
      footer: (
        <span className="text-xs text-slate-500">
          Onboarding link ships in Phase 18; until then, set up via your account manager.
        </span>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Integrations</CardTitle>
          <CardSubtitle>
            Read-only status. Credential management lives outside the portal so secrets never travel
            the public surface.
          </CardSubtitle>
        </div>
      </CardHeader>
      <CardBody className="divide-y divide-slate-100">
        {rows.map((row, idx) => (
          <IntegrationRow key={idx} {...row} />
        ))}
      </CardBody>
    </Card>
  );
}

function IntegrationRow({ icon, title, subtitle, connected, footer }: RowSpec): ReactNode {
  const tone: BadgeTone = connected ? 'success' : 'neutral';
  return (
    <div className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-slate-50 text-slate-700">
        {icon}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-slate-900">{title}</h3>
          <Badge tone={tone}>
            {connected ? (
              <>
                <CheckCircle2 aria-hidden="true" className="h-3 w-3" />
                Connected
              </>
            ) : (
              <>
                <CircleSlash aria-hidden="true" className="h-3 w-3" />
                Not connected
              </>
            )}
          </Badge>
        </div>
        <p className="text-sm text-slate-500">{subtitle}</p>
        {footer !== undefined ? <div className="mt-1">{footer}</div> : null}
      </div>
    </div>
  );
}
