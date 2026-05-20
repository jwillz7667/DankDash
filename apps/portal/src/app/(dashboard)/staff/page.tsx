import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { PagePlaceholder } from '../../../components/shell/page-placeholder.js';

export const metadata: Metadata = {
  title: 'Staff — DankDash for Business',
};

export default function StaffPage(): ReactNode {
  return (
    <PagePlaceholder
      title="Staff"
      description="Budtenders, managers, and owners attached to this dispensary."
      phase="Phase 16"
    >
      <p>
        Invite flows, role assignment, and MFA enforcement reporting land in Phase 16. The role
        gates in Phase 13 already hide this entry from budtenders so the surface can ship without
        re-doing access control.
      </p>
    </PagePlaceholder>
  );
}
