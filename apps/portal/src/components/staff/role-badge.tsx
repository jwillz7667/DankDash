import { type ReactNode } from 'react';
import { roleLabel } from '../../lib/staff/format.js';
import { Badge, type BadgeTone } from '../ui/badge.js';
import type { VendorStaffRole } from '../../lib/api/vendor-staff.js';

const TONE: Readonly<Record<VendorStaffRole, BadgeTone>> = {
  budtender: 'neutral',
  manager: 'info',
  owner: 'accent',
};

export function RoleBadge({ role }: { readonly role: VendorStaffRole }): ReactNode {
  return <Badge tone={TONE[role]}>{roleLabel(role)}</Badge>;
}
