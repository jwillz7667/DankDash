import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotificationControls } from './notification-controls.js';

function defaultProps(): Parameters<typeof NotificationControls>[0] {
  return {
    isMuted: false,
    onToggleMuted: vi.fn(),
    permission: 'default',
    onRequestPermission: vi.fn(),
  };
}

describe('NotificationControls', () => {
  it('renders the mute toggle with the unmuted bell icon by default', () => {
    render(<NotificationControls {...defaultProps()} />);
    const toggle = screen.getByTestId('notification-mute-toggle');
    expect(toggle.getAttribute('data-muted')).toBe('false');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Mute new-order alerts');
  });

  it('flips to the muted bell-off variant when isMuted=true', () => {
    render(<NotificationControls {...defaultProps()} isMuted />);
    const toggle = screen.getByTestId('notification-mute-toggle');
    expect(toggle.getAttribute('data-muted')).toBe('true');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Unmute new-order alerts');
  });

  it('fires onToggleMuted (and onUserGesture) when the toggle is clicked', () => {
    const onToggleMuted = vi.fn();
    const onUserGesture = vi.fn();
    render(
      <NotificationControls
        {...defaultProps()}
        onToggleMuted={onToggleMuted}
        onUserGesture={onUserGesture}
      />,
    );
    fireEvent.click(screen.getByTestId('notification-mute-toggle'));
    expect(onUserGesture).toHaveBeenCalledTimes(1);
    expect(onToggleMuted).toHaveBeenCalledTimes(1);
  });

  it('renders the "Enable alerts" CTA only while permission is "default"', () => {
    const { rerender } = render(<NotificationControls {...defaultProps()} permission="default" />);
    expect(screen.queryByTestId('notification-permission-request')).not.toBeNull();

    rerender(<NotificationControls {...defaultProps()} permission="granted" />);
    expect(screen.queryByTestId('notification-permission-request')).toBeNull();

    rerender(<NotificationControls {...defaultProps()} permission="denied" />);
    expect(screen.queryByTestId('notification-permission-request')).toBeNull();
  });

  it('fires onRequestPermission and onUserGesture when "Enable alerts" is clicked', () => {
    const onRequestPermission = vi.fn();
    const onUserGesture = vi.fn();
    render(
      <NotificationControls
        {...defaultProps()}
        permission="default"
        onRequestPermission={onRequestPermission}
        onUserGesture={onUserGesture}
      />,
    );
    fireEvent.click(screen.getByTestId('notification-permission-request'));
    expect(onUserGesture).toHaveBeenCalledTimes(1);
    expect(onRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('renders the "Notifications blocked" hint when permission is "denied"', () => {
    render(<NotificationControls {...defaultProps()} permission="denied" />);
    expect(screen.queryByTestId('notification-permission-blocked')).not.toBeNull();
  });

  it('hides both controls entirely when the Notification API is unsupported', () => {
    render(<NotificationControls {...defaultProps()} permission="unsupported" />);
    expect(screen.queryByTestId('notification-mute-toggle')).toBeNull();
    expect(screen.queryByTestId('notification-permission-request')).toBeNull();
    expect(screen.queryByTestId('notification-permission-blocked')).toBeNull();
  });
});
