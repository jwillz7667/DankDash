import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type Compliance } from '@/lib/api-schemas';
import { ComplianceSummary } from './compliance-summary.js';

function compliance(overrides: Partial<Compliance> = {}): Compliance {
  return {
    passed: true,
    rules: [],
    cartTotals: { flowerGrams: 10, concentrateGrams: 1, edibleThcMg: 100 },
    limits: { flowerGramsMax: 56.7, concentrateGramsMax: 8, edibleThcMgMax: 800 },
    evaluatedAt: '2026-06-28T18:00:00.000Z',
    evaluationVersion: 'v1',
    ...overrides,
  };
}

describe('ComplianceSummary', () => {
  it('renders the three statutory usage bars', () => {
    render(<ComplianceSummary compliance={compliance()} />);
    expect(screen.getByLabelText('Flower usage')).toBeInTheDocument();
    expect(screen.getByLabelText('Concentrate usage')).toBeInTheDocument();
    expect(screen.getByLabelText('Edible THC usage')).toBeInTheDocument();
  });

  it('shows no blocking notice when the evaluation passed', () => {
    render(<ComplianceSummary compliance={compliance({ passed: true, rules: [] })} />);
    expect(screen.queryByText(/can.t be completed/i)).not.toBeInTheDocument();
  });

  it('lists the failed rules when the evaluation failed', () => {
    render(
      <ComplianceSummary
        compliance={compliance({
          passed: false,
          rules: [
            { rule: 'per_transaction_limit', passed: false, details: {} },
            { rule: 'delivery_geofence', passed: false, details: {} },
            { rule: 'age', passed: true, details: {} },
          ],
        })}
      />,
    );
    const notice = screen.getByText(/can.t be completed/i);
    expect(notice).toHaveTextContent('Purchase limit');
    expect(notice).toHaveTextContent('Delivery area');
    expect(notice).not.toHaveTextContent('Age verification');
  });
});
