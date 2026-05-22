import { redirect } from 'next/navigation';

/**
 * The portal has no public marketing surface — every entry point
 * resolves to either /login (handled by middleware) or /dashboard.
 * This file exists so a direct hit on `/` doesn't 404.
 */
export default function RootPage(): never {
  redirect('/dashboard');
}
