import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRID_PRECISION_DEGREES,
  gridPairCacheKey,
  quantizeToGrid,
  type GridCell,
} from '../src/grid.js';

describe('quantizeToGrid', () => {
  it('quantizes a Minneapolis City Hall point to its default-precision cell', () => {
    const cell = quantizeToGrid({ lat: 44.97798, lng: -93.26528 });
    expect(cell).toEqual<GridCell>({ latIndex: 44978, lngIndex: -93265 });
  });

  it('places two points 25m apart in the same cell (sub-grid resolution)', () => {
    const a = quantizeToGrid({ lat: 44.97798, lng: -93.26528 });
    const b = quantizeToGrid({ lat: 44.97798, lng: -93.2651 }); // ~14m east
    expect(a).toEqual(b);
  });

  it('places two points >150m apart in different cells', () => {
    const a = quantizeToGrid({ lat: 44.97798, lng: -93.26528 });
    const b = quantizeToGrid({ lat: 44.97798, lng: -93.2635 }); // ~140m east
    expect(a).not.toEqual(b);
  });

  it('respects a custom precision (10× wider cell)', () => {
    // At 0.01° precision both points round to (4498, -9326): the first
    // because 44.97798/0.01=4497.798 → 4498, the second because
    // 44.978/0.01=4497.8 → 4498. lng: -93.264/0.01=-9326.4 → -9326,
    // -93.260/0.01=-9326.0 → -9326.
    const a = quantizeToGrid({ lat: 44.978, lng: -93.264 }, 0.01);
    const b = quantizeToGrid({ lat: 44.97798, lng: -93.26 }, 0.01);
    expect(a).toEqual({ latIndex: 4498, lngIndex: -9326 });
    expect(a).toEqual(b);
  });

  it('throws on a non-finite lat/lng', () => {
    expect(() => quantizeToGrid({ lat: Number.NaN, lng: 0 })).toThrow(RangeError);
    expect(() => quantizeToGrid({ lat: 0, lng: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('throws on zero or negative precision', () => {
    expect(() => quantizeToGrid({ lat: 0, lng: 0 }, 0)).toThrow(RangeError);
    expect(() => quantizeToGrid({ lat: 0, lng: 0 }, -0.001)).toThrow(RangeError);
    expect(() => quantizeToGrid({ lat: 0, lng: 0 }, Number.NaN)).toThrow(RangeError);
  });

  it('exports the spec-mandated default precision (≈100m cells in MN)', () => {
    expect(DEFAULT_GRID_PRECISION_DEGREES).toBe(0.001);
  });
});

describe('gridPairCacheKey', () => {
  it('produces a stable, human-readable key', () => {
    const from = quantizeToGrid({ lat: 44.97798, lng: -93.26528 });
    const to = quantizeToGrid({ lat: 44.98, lng: -93.27 });
    expect(gridPairCacheKey(from, to)).toBe('eta:v1:44978,-93265:44980,-93270');
  });

  it('is asymmetric — (a,b) and (b,a) are different keys', () => {
    const a: GridCell = { latIndex: 1, lngIndex: 2 };
    const b: GridCell = { latIndex: 3, lngIndex: 4 };
    expect(gridPairCacheKey(a, b)).not.toBe(gridPairCacheKey(b, a));
  });

  it('uses a versioned prefix so a schema rev can roll without collisions', () => {
    expect(gridPairCacheKey({ latIndex: 0, lngIndex: 0 }, { latIndex: 0, lngIndex: 0 })).toMatch(
      /^eta:v1:/,
    );
  });
});
