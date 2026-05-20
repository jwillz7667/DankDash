import { redirect } from 'next/navigation';

export default function SettingsIndexPage(): never {
  redirect('/settings/store');
}
