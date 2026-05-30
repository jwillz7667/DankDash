'use client';

import { Bell, BellOff, BellRing, ShieldAlert } from 'lucide-react';
import { useCallback, type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';
import type { NotificationPermissionState } from '../../lib/notifications/browser.js';

export interface NotificationControlsProps {
  readonly isMuted: boolean;
  readonly onToggleMuted: () => void;
  readonly permission: NotificationPermissionState;
  readonly onRequestPermission: () => void;
  /**
   * Fired before any control's primary side effect, on every click.
   * The board wires this to `primeFromGesture()` so the very first
   * user interaction unlocks the AudioContext — without this, the
   * first realtime chime after page load would be silent on Chrome.
   */
  readonly onUserGesture?: () => void;
}

/**
 * Two-control cluster that lives next to the realtime status badge:
 *
 *   1. **Enable alerts** button — visible only while permission is
 *      `'default'`. Clicking calls `Notification.requestPermission()`
 *      under a user gesture (the only context Chrome accepts).
 *   2. **Mute toggle** — bell / bell-off icon button. Toggles the
 *      session-scoped mute flag. Always visible so the operator has
 *      a one-click "quiet please" escape during a phone call.
 *
 * A `'denied'` state surfaces a small "Notifications blocked" hint
 * with no action — the only fix is the browser's own site settings,
 * which a button can't open programmatically.
 *
 * A `'granted'` state hides the request CTA entirely (no need to
 * prompt for something the operator has already granted).
 *
 * An `'unsupported'` state hides both — there's nothing to do.
 */
export function NotificationControls({
  isMuted,
  onToggleMuted,
  permission,
  onRequestPermission,
  onUserGesture,
}: NotificationControlsProps): ReactNode {
  const handleToggle = useCallback((): void => {
    onUserGesture?.();
    onToggleMuted();
  }, [onUserGesture, onToggleMuted]);

  const handleRequest = useCallback((): void => {
    onUserGesture?.();
    onRequestPermission();
  }, [onUserGesture, onRequestPermission]);

  const showRequest = permission === 'default';
  const showBlocked = permission === 'denied';
  const showToggle = permission !== 'unsupported';

  return (
    <div className="flex items-center gap-2" data-testid="notification-controls">
      {showRequest && (
        <button
          type="button"
          onClick={handleRequest}
          data-testid="notification-permission-request"
          className="inline-flex items-center gap-1.5 rounded-lg border border-moss-200 bg-moss-50 px-2.5 py-1 text-xs font-medium text-moss-700 transition-colors hover:bg-moss-100"
        >
          <BellRing aria-hidden="true" className="h-3.5 w-3.5" />
          Enable alerts
        </button>
      )}
      {showBlocked && (
        <span
          data-testid="notification-permission-blocked"
          className="inline-flex items-center gap-1 text-xs text-muted"
          title="Browser notifications are blocked. Re-enable from your browser's site settings to see new-order toasts."
        >
          <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5" />
          Notifications blocked
        </span>
      )}
      {showToggle && (
        <button
          type="button"
          onClick={handleToggle}
          data-testid="notification-mute-toggle"
          data-muted={isMuted ? 'true' : 'false'}
          aria-pressed={isMuted}
          aria-label={isMuted ? 'Unmute new-order alerts' : 'Mute new-order alerts'}
          title={
            isMuted
              ? 'Unmute new-order alerts for this session'
              : 'Mute new-order alerts for this session'
          }
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
            isMuted
              ? 'border-outline bg-surface-muted text-muted hover:bg-surface-subtle'
              : 'border-moss-200 bg-surface text-moss-700 hover:bg-moss-50',
          )}
        >
          {isMuted ? (
            <BellOff aria-hidden="true" className="h-4 w-4" />
          ) : (
            <Bell aria-hidden="true" className="h-4 w-4" />
          )}
        </button>
      )}
    </div>
  );
}
