import { type Metadata } from 'next';
import { type ReactNode } from 'react';
import { PagePlaceholder } from '../../../components/shell/page-placeholder.js';

export const metadata: Metadata = {
  title: 'Menu — DankDash for Business',
};

export default function MenuPage(): ReactNode {
  return (
    <PagePlaceholder
      title="Menu"
      description="Listings, pricing, inventory, and COA attachments per SKU."
      phase="Phase 15"
    />
  );
}
