/**
 * Thin wrapper around `axe-core` for unit-level a11y assertions.
 *
 * Why a wrapper at all:
 *
 *   - `axe.run()` returns a Promise with multiple overloads — callers
 *     should not have to remember the exact signature for the
 *     `(context, options)` form.
 *   - jsdom does not implement CSS layout, so the `color-contrast` rule
 *     always reports "Cannot determine the color of an element" as
 *     `incomplete` and frequently produces noisy `serious` violations on
 *     synthetic snapshots. We disable it here at the helper level so
 *     every test stays focused on structural a11y (roles, labels,
 *     focus order, landmarks).
 *   - jsdom also lacks scrolling APIs that the `scrollable-region-focusable`
 *     rule probes — disabling it removes false positives where overflow
 *     containers look "scrollable" but actually aren't in a real
 *     browser.
 *   - Asserting on the result requires unpacking the violation array
 *     into a readable diff. `expectNoA11yViolations` does that once.
 *
 * Production e2e specs use `@axe-core/playwright` instead — that path
 * pipes axe into a real browser, where color-contrast and layout-based
 * rules actually run.
 */
import axe, { type AxeResults, type RunOptions } from 'axe-core';
import { expect } from 'vitest';

const DEFAULT_DISABLED_RULES: ReadonlyArray<string> = [
  'color-contrast',
  'scrollable-region-focusable',
];

export interface CheckA11yOptions {
  /**
   * Extra axe rules to disable for this run. The helper always disables
   * {@link DEFAULT_DISABLED_RULES} on top of whatever the caller adds.
   */
  readonly disabledRules?: readonly string[];
  /**
   * Extra runOptions forwarded to `axe.run`. Mostly useful for scoping
   * to a specific WCAG tag (`runOnly: { type: 'tag', values: ['wcag2a'] }`).
   */
  readonly runOptions?: RunOptions;
}

export async function checkA11y(
  container: Element,
  options: CheckA11yOptions = {},
): Promise<AxeResults> {
  const disabled = [...DEFAULT_DISABLED_RULES, ...(options.disabledRules ?? [])];
  const rules = Object.fromEntries(disabled.map((id) => [id, { enabled: false } as const]));
  const runOptions: RunOptions = { rules, ...(options.runOptions ?? {}) };
  return axe.run(container, runOptions);
}

/**
 * Asserts the axe report contains zero violations. On failure, the
 * error message lists each violation's rule id, impact, and the first
 * offending element's HTML so the failure is actionable without having
 * to expand the raw JSON.
 */
export function expectNoA11yViolations(results: AxeResults): void {
  if (results.violations.length === 0) {
    expect(results.violations).toEqual([]);
    return;
  }
  const summary = results.violations
    .map((v) => {
      const sample = v.nodes[0]?.html ?? '(no node)';
      return `  - [${v.impact ?? 'unknown'}] ${v.id}: ${v.help}\n    ${sample}`;
    })
    .join('\n');
  throw new Error(`Found ${String(results.violations.length)} a11y violation(s):\n${summary}`);
}
