/**
 * axe-core a11y assertions for {@link NotificationControls} — covers
 * every permission state and the muted toggle variant. The control
 * cluster lives next to the realtime badge on the queue board header
 * (Phase 14 DoD requires zero violations across this surface).
 */
import { render } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import { checkA11y, expectNoA11yViolations } from '../../../test/utils/axe.js';
import type { NotificationPermissionState } from '../../lib/notifications/browser.js';
import { NotificationControls } from './notification-controls.js';

function harness(
  permission: NotificationPermissionState,
  options: { isMuted?: boolean } = {},
): HTMLElement {
  const { container } = render(
    <main>
      <NotificationControls
        permission={permission}
        isMuted={options.isMuted ?? false}
        onToggleMuted={vi.fn()}
        onRequestPermission={vi.fn()}
        onUserGesture={vi.fn()}
      />
    </main>,
  );
  return container;
}

describe('NotificationControls — a11y', () => {
  it.each<NotificationPermissionState>(['default', 'granted', 'denied', 'unsupported'])(
    'has zero violations when permission is "%s"',
    async (permission) => {
      const container = harness(permission);
      const results = await checkA11y(container);
      expectNoA11yViolations(results);
    },
  );

  it('has zero violations in the muted state', async () => {
    const container = harness('granted', { isMuted: true });
    const results = await checkA11y(container);
    expectNoA11yViolations(results);
  });
});
