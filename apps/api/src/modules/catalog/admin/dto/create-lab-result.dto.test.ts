/**
 * Unit tests for CreateLabResultRequestSchema.
 *
 * Behaviours pinned:
 *   - Required fields present → parses.
 *   - .strict — unknown top-level fields rejected (productId in the body
 *     is the most common typo; URL is authoritative).
 *   - testedAt is YYYY-MM-DD (the column is `date`); other formats rejected.
 *   - Potency fields are decimal strings (precision preservation) and
 *     accept explicit null for "we didn't measure it".
 *   - contaminantsPassed is nullable boolean — failure to test ≠ pass.
 */
import { describe, expect, it } from 'vitest';
import { CreateLabResultRequestSchema } from './create-lab-result.dto.js';

describe('CreateLabResultRequestSchema', () => {
  it('parses a minimal valid body', () => {
    const parsed = CreateLabResultRequestSchema.parse({
      batchId: 'OCM-BATCH-001',
      labName: 'Steep Hill Minnesota',
      testedAt: '2026-05-01',
    });
    expect(parsed.batchId).toBe('OCM-BATCH-001');
    expect(parsed.coaDocumentKey).toBeUndefined();
  });

  it('accepts every optional field', () => {
    const parsed = CreateLabResultRequestSchema.parse({
      batchId: 'OCM-BATCH-002',
      labName: 'Steep Hill Minnesota',
      coaDocumentKey: 'coas/north-star/2026-05-01.pdf',
      potencyThc: '24.123',
      potencyCbd: '0.500',
      contaminantsPassed: true,
      testedAt: '2026-05-01',
    });
    expect(parsed.potencyThc).toBe('24.123');
    expect(parsed.contaminantsPassed).toBe(true);
  });

  it('accepts explicit-null potency and contaminantsPassed', () => {
    const parsed = CreateLabResultRequestSchema.parse({
      batchId: 'OCM-BATCH-003',
      labName: 'Steep Hill Minnesota',
      potencyThc: null,
      potencyCbd: null,
      contaminantsPassed: null,
      coaDocumentKey: null,
      testedAt: '2026-05-01',
    });
    expect(parsed.potencyThc).toBeNull();
    expect(parsed.contaminantsPassed).toBeNull();
  });

  it('rejects unknown top-level fields (productId in body — URL is authoritative)', () => {
    expect(() =>
      CreateLabResultRequestSchema.parse({
        batchId: 'OCM-BATCH-004',
        labName: 'Lab',
        testedAt: '2026-05-01',
        productId: '01935f3d-0000-7000-8000-000000000001',
      }),
    ).toThrow();
  });

  it('rejects a non-ISO testedAt', () => {
    expect(() =>
      CreateLabResultRequestSchema.parse({
        batchId: 'OCM-BATCH-005',
        labName: 'Lab',
        testedAt: '05/01/2026',
      }),
    ).toThrow();
  });

  it('rejects an empty batchId', () => {
    expect(() =>
      CreateLabResultRequestSchema.parse({
        batchId: '',
        labName: 'Lab',
        testedAt: '2026-05-01',
      }),
    ).toThrow();
  });

  it('rejects a non-numeric potencyThc', () => {
    expect(() =>
      CreateLabResultRequestSchema.parse({
        batchId: 'OCM-BATCH-006',
        labName: 'Lab',
        potencyThc: 'high',
        testedAt: '2026-05-01',
      }),
    ).toThrow();
  });
});
