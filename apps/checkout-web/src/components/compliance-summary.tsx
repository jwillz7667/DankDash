import { type ReactNode } from 'react';
import { type Compliance } from '@/lib/api-schemas';
import { complianceBars, failedRuleLabel } from '@/lib/format';

/**
 * Renders the server-authoritative compliance snapshot: three usage bars
 * (flower / concentrate / edible THC against the MN statutory caps) and, when
 * the evaluation failed, the list of rules that blocked the order. The server
 * is authoritative — this only visualises what it returned.
 */
export function ComplianceSummary({ compliance }: { compliance: Compliance }): ReactNode {
  const bars = complianceBars(compliance);
  const failed = compliance.rules.filter((r) => !r.passed);

  return (
    <div className="card" aria-label="Compliance summary">
      <h2>Compliance</h2>
      {bars.map((bar) => (
        <div className="bar" key={bar.label}>
          <div className="bar-head">
            <span>{bar.label}</span>
            <span className="mono muted">
              {bar.used}
              {bar.unit} / {bar.max}
              {bar.unit}
            </span>
          </div>
          <div className="bar-track">
            <div
              className={`bar-fill ${bar.tone === 'ok' ? '' : bar.tone}`}
              style={{ width: `${String(bar.percent)}%` }}
              role="progressbar"
              aria-valuenow={bar.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${bar.label} usage`}
            />
          </div>
        </div>
      ))}
      {failed.length > 0 ? (
        <div className="notice error" style={{ marginTop: 12, marginBottom: 0 }}>
          This order can&apos;t be completed:{' '}
          {failed.map((r) => failedRuleLabel(r.rule)).join(', ')}.
        </div>
      ) : null}
    </div>
  );
}
