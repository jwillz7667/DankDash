/**
 * Direct unit tests for the ray-cast point-in-polygon implementation.
 * The geofence rule wraps this, but the algorithmic edge cases (degenerate
 * geometry, holes, asymmetric boundary semantics) deserve direct coverage
 * so that a future refactor of the rule layer can't quietly delete them.
 */
import { describe, expect, it } from 'vitest';
import { pointInPolygon } from '../src/index.js';
import type { Polygon } from 'geojson';

const SQUARE: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
};

describe('pointInPolygon — basic containment', () => {
  it('reports the centroid of a simple square as inside', () => {
    expect(pointInPolygon({ latitude: 5, longitude: 5 }, SQUARE)).toBe(true);
  });

  it('reports a point far outside the square as outside', () => {
    expect(pointInPolygon({ latitude: 100, longitude: 100 }, SQUARE)).toBe(false);
  });

  it('reports a point just inside the boundary as inside', () => {
    expect(pointInPolygon({ latitude: 0.001, longitude: 0.001 }, SQUARE)).toBe(true);
  });
});

describe('pointInPolygon — boundary semantics (ray-cast convention)', () => {
  it('reports the south edge as inside', () => {
    expect(pointInPolygon({ latitude: 0, longitude: 5 }, SQUARE)).toBe(true);
  });

  it('reports the west edge as inside', () => {
    expect(pointInPolygon({ latitude: 5, longitude: 0 }, SQUARE)).toBe(true);
  });

  it('reports the north edge as outside', () => {
    expect(pointInPolygon({ latitude: 10, longitude: 5 }, SQUARE)).toBe(false);
  });

  it('reports the east edge as outside', () => {
    expect(pointInPolygon({ latitude: 5, longitude: 10 }, SQUARE)).toBe(false);
  });

  it('reports the south-west corner (origin vertex) as inside', () => {
    expect(pointInPolygon({ latitude: 0, longitude: 0 }, SQUARE)).toBe(true);
  });

  it('reports the north-east corner as outside', () => {
    expect(pointInPolygon({ latitude: 10, longitude: 10 }, SQUARE)).toBe(false);
  });
});

describe('pointInPolygon — degenerate inputs', () => {
  it('returns false when the polygon has no rings', () => {
    const empty: Polygon = { type: 'Polygon', coordinates: [] };
    expect(pointInPolygon({ latitude: 0, longitude: 0 }, empty)).toBe(false);
  });

  it('returns false when the outer ring has fewer than 3 vertices', () => {
    const twoPoints: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    };
    expect(pointInPolygon({ latitude: 0, longitude: 0 }, twoPoints)).toBe(false);
  });

  it('tolerates a malformed position in the outer ring (skips it)', () => {
    // Position with a single coordinate — should be skipped, not crash.
    const malformed = {
      type: 'Polygon',
      coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0], [0, 0]]],
    } as unknown as Polygon;
    // Centroid still resolves correctly because the algorithm skips the
    // single-element position rather than crashing.
    expect(pointInPolygon({ latitude: 5, longitude: 5 }, malformed)).toBe(true);
  });
});

describe('pointInPolygon — holes (inner rings)', () => {
  const SQUARE_WITH_HOLE: Polygon = {
    type: 'Polygon',
    coordinates: [
      // Outer 0..10
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      // Hole 3..7 centered on the centroid
      [
        [3, 3],
        [7, 3],
        [7, 7],
        [3, 7],
        [3, 3],
      ],
    ],
  };

  it('reports a point inside the hole as outside the polygon', () => {
    expect(pointInPolygon({ latitude: 5, longitude: 5 }, SQUARE_WITH_HOLE)).toBe(false);
  });

  it('reports a point in the outer ring but not in the hole as inside', () => {
    expect(pointInPolygon({ latitude: 1, longitude: 1 }, SQUARE_WITH_HOLE)).toBe(true);
  });

  it('skips a degenerate hole rather than treating it as exclusionary', () => {
    const degenerateHole: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        // Two-vertex "hole" — not a real polygon, should be skipped.
        [
          [4, 4],
          [6, 6],
        ],
      ],
    };
    expect(pointInPolygon({ latitude: 5, longitude: 5 }, degenerateHole)).toBe(true);
  });

  it('subtracts multiple holes', () => {
    const twoHoles: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 2],
          [1, 1],
        ],
        [
          [7, 7],
          [9, 7],
          [9, 9],
          [7, 9],
          [7, 7],
        ],
      ],
    };
    // In second hole
    expect(pointInPolygon({ latitude: 8, longitude: 8 }, twoHoles)).toBe(false);
    // In first hole
    expect(pointInPolygon({ latitude: 1.5, longitude: 1.5 }, twoHoles)).toBe(false);
    // Outer ring, outside both holes
    expect(pointInPolygon({ latitude: 5, longitude: 5 }, twoHoles)).toBe(true);
  });
});

describe('pointInPolygon — non-convex shapes', () => {
  it('correctly handles a concave (C-shaped) polygon', () => {
    // C opening to the right: indentation between y=4 and y=6
    const cShape: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 4],
          [5, 4],
          [5, 6],
          [10, 6],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    };
    // Inside the C (left arm)
    expect(pointInPolygon({ latitude: 5, longitude: 2 }, cShape)).toBe(true);
    // In the mouth of the C — outside the polygon
    expect(pointInPolygon({ latitude: 5, longitude: 7 }, cShape)).toBe(false);
    // In the top arm
    expect(pointInPolygon({ latitude: 8, longitude: 7 }, cShape)).toBe(true);
  });
});
