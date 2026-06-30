/**
 * Canonical list of top-level sidebar destinations + the settings
 * sub-routes. Used by both the sidebar component and the e2e nav
 * smoke test — a missing route here means the test won't cover it.
 */
import {
  BarChart3,
  Banknote,
  LayoutDashboard,
  ListChecks,
  Package,
  Settings,
  ShoppingBag,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { UserRole } from '../../lib/api/types.js';

export interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /**
   * Roles allowed to see this nav item. The middleware also enforces
   * route-level role gates; the nav layer just hides items that
   * would 403 anyway.
   */
  readonly roles: ReadonlyArray<UserRole>;
}

const VENDOR_ROLES: ReadonlyArray<UserRole> = [
  'budtender',
  'manager',
  'owner',
  'admin',
  'superadmin',
];
const MANAGER_PLUS: ReadonlyArray<UserRole> = ['manager', 'owner', 'admin', 'superadmin'];

export const PRIMARY_NAV: ReadonlyArray<NavItem> = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    roles: VENDOR_ROLES,
  },
  { key: 'orders', label: 'Orders', href: '/orders', icon: ListChecks, roles: VENDOR_ROLES },
  { key: 'menu', label: 'Menu', href: '/menu', icon: ShoppingBag, roles: VENDOR_ROLES },
  { key: 'products', label: 'Products', href: '/products', icon: Package, roles: MANAGER_PLUS },
  { key: 'staff', label: 'Staff', href: '/staff', icon: Users, roles: MANAGER_PLUS },
  { key: 'payouts', label: 'Payouts', href: '/payouts', icon: Banknote, roles: MANAGER_PLUS },
  {
    key: 'analytics',
    label: 'Analytics',
    href: '/analytics',
    icon: BarChart3,
    roles: VENDOR_ROLES,
  },
  {
    key: 'settings',
    label: 'Settings',
    href: '/settings/store',
    icon: Settings,
    roles: MANAGER_PLUS,
  },
];

export const SETTINGS_NAV: ReadonlyArray<NavItem> = [
  {
    key: 'settings-store',
    label: 'Store',
    href: '/settings/store',
    icon: Settings,
    roles: MANAGER_PLUS,
  },
  {
    key: 'settings-integrations',
    label: 'Integrations',
    href: '/settings/integrations',
    icon: Settings,
    roles: MANAGER_PLUS,
  },
  {
    key: 'settings-compliance',
    label: 'Compliance',
    href: '/settings/compliance',
    icon: Settings,
    roles: MANAGER_PLUS,
  },
];

export function visibleFor(items: ReadonlyArray<NavItem>, role: UserRole): ReadonlyArray<NavItem> {
  return items.filter((item) => item.roles.includes(role));
}
