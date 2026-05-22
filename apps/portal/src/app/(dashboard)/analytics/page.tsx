import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { PagePlaceholder } from '../../../components/shell/page-placeholder.js';

export const metadata: Metadata = {
  title: 'Analytics — DankDash for Business',
};

export default function AnalyticsPage(): ReactNode {
  return (
    <PagePlaceholder
      title="Analytics"
      description="Revenue by day, top SKUs, customer cohorts, and compliance trends."
      phase="Phase 17"
    />
  );
}
