/**
 * Full-page browser navigation seam. A one-liner around
 * `window.location.assign`, extracted so components that hand control to an
 * external hosted flow (e.g. the Aeropay bank-link redirect) can be unit
 * tested by mocking this module — jsdom does not implement real navigation.
 */
export function redirectTo(url: string): void {
  window.location.assign(url);
}
