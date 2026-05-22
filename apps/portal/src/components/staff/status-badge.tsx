import { type ReactNode } from 'react';
import { statusLabel, type StaffStatus } from '../../lib/staff/format.js';
import { Badge, type BadgeTone } from '../ui/badge.js';

const TONE: Readonly<Record<StaffStatus, BadgeTone>> = {
  active: 'success',
  pending: 'warning',
  removed: 'neutral',
};

export function StaffStatusBadge({ status }: { readonly status: StaffStatus }): ReactNode {
  return <Badge tone={TONE[status]}>{statusLabel(status)}</Badge>;
}
