import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SyncBanner } from './sync-banner.js';

const NOW = new Date('2026-05-20T12:00:00.000Z');

function makeBanner(overrides: {
  oldestLastSyncedAt?: string | null;
  onSync?: () => Promise<{ updated: number; syncedAt: string }>;
  onSyncCompleted?: (result: { updated: number; syncedAt: string }) => void;
}) {
  const onSync =
    overrides.onSync ?? (() => Promise.resolve({ updated: 0, syncedAt: NOW.toISOString() }));
  const onSyncCompleted = overrides.onSyncCompleted;
  const oldestLastSyncedAt =
    'oldestLastSyncedAt' in overrides ? (overrides.oldestLastSyncedAt ?? null) : NOW.toISOString();
  return render(
    <SyncBanner
      oldestLastSyncedAt={oldestLastSyncedAt}
      onSync={onSync}
      onSyncCompleted={onSyncCompleted}
      now={NOW}
    />,
  );
}

describe('SyncBanner', () => {
  it('shows a "Synced just now" badge when freshness is < 90s', () => {
    makeBanner({ oldestLastSyncedAt: new Date(NOW.getTime() - 30_000).toISOString() });
    expect(screen.getByText(/Synced just now/i)).toBeInTheDocument();
  });

  it('shows a stale label and danger tone when last sync was over a day ago', () => {
    makeBanner({
      oldestLastSyncedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(screen.getByText(/Synced/)).toBeInTheDocument();
    // Stale -> danger badge has aria-label "sync danger"
    expect(screen.getByLabelText('sync danger')).toBeInTheDocument();
  });

  it('renders "Never synced" with a neutral badge when oldestLastSyncedAt is null', () => {
    makeBanner({ oldestLastSyncedAt: null });
    expect(screen.getByText('Never synced')).toBeInTheDocument();
    expect(screen.getByLabelText('sync neutral')).toBeInTheDocument();
  });

  it('clicking "Sync now" calls onSync, shows a busy state, then onSyncCompleted', async () => {
    const onSync = vi
      .fn<() => Promise<{ updated: number; syncedAt: string }>>()
      .mockResolvedValue({ updated: 3, syncedAt: NOW.toISOString() });
    const onSyncCompleted = vi.fn();
    makeBanner({ onSync, onSyncCompleted });

    fireEvent.click(screen.getByRole('button', { name: /Sync menu with POS/i }));

    expect(onSync).toHaveBeenCalledTimes(1);
    // While in-flight the button text reads "Syncing…"
    expect(await screen.findByText(/Syncing…/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(onSyncCompleted).toHaveBeenCalledWith({ updated: 3, syncedAt: NOW.toISOString() });
    });
  });

  it('surfaces a generic error message when onSync rejects', async () => {
    const onSync = vi
      .fn<() => Promise<{ updated: number; syncedAt: string }>>()
      .mockRejectedValue(new Error('boom'));
    makeBanner({ onSync });

    fireEvent.click(screen.getByRole('button', { name: /Sync menu with POS/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't sync the menu/i);
    // Button restored to idle state
    expect(screen.getByRole('button', { name: /Sync menu with POS/i })).not.toBeDisabled();
  });
});
