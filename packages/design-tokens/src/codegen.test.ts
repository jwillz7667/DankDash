import { describe, expect, it } from 'vitest';
import { tokens } from './tokens.js';
import { emitSwift } from './codegen.js';

describe('emitSwift', () => {
  const output = emitSwift();

  it('produces a Swift file with the auto-generated banner', () => {
    expect(output.startsWith('// AUTO-GENERATED')).toBe(true);
    expect(output).toContain('import SwiftUI');
  });

  it('emits the canonical primary green at scale step 500', () => {
    // #3B9322 → (0x3B / 255, 0x93 / 255, 0x22 / 255)
    expect(output).toContain('internal static let primary500 = Color(.sRGB, red: 0.2314');
  });

  it('emits glass as a translucent white', () => {
    expect(output).toContain(
      'internal static let glass = Color(.sRGB, red: 1, green: 1, blue: 1, opacity: 0.08)',
    );
  });

  it('emits the full 4-pt spacing scale', () => {
    for (const [name, value] of Object.entries(tokens.spacing)) {
      expect(output).toContain(`internal static let ${name}: CGFloat = ${value}`);
    }
  });

  it('emits typography tokens with the expected text style for each size', () => {
    expect(output).toContain(
      'internal static let display: Font = .system(.title, design: .rounded, weight: .bold)',
    );
    expect(output).toContain(
      'internal static let mono: Font = .system(.footnote, design: .monospaced, weight: .medium)',
    );
  });

  it('groups shadow descriptors as nested enums', () => {
    expect(output).toContain('internal enum Sm {');
    expect(output).toContain('internal enum Ring {');
  });

  it('emits semantic-state soft tints alongside their base colors', () => {
    expect(output).toContain('internal static let semanticDanger = Color(.sRGB, red:');
    expect(output).toContain('internal static let semanticDangerSoft = Color(.sRGB, red:');
    expect(output).toContain('internal static let semanticWarningSoft = Color(.sRGB, red:');
    expect(output).toContain('internal static let semanticSuccessSoft = Color(.sRGB, red:');
    expect(output).toContain('internal static let semanticInfoSoft = Color(.sRGB, red:');
  });

  it('emits surface and border tones used by the portal token aliases', () => {
    expect(output).toContain('internal static let surfaceDefault = Color(.sRGB, red: 1, green: 1');
    expect(output).toContain('internal static let surfaceMuted = Color(.sRGB, red:');
    expect(output).toContain('internal static let surfaceInverse = Color(.sRGB, red:');
    expect(output).toContain('internal static let borderDefault = Color(.sRGB, red:');
    expect(output).toContain('internal static let borderSubtle = Color(.sRGB, red:');
    expect(output).toContain('internal static let borderStrong = Color(.sRGB, red:');
  });
});
