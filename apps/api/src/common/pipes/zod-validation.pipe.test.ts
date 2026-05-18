/**
 * Unit tests for ZodValidationPipe.
 *
 * The pipe sits at the request boundary; the contract we want to lock
 * down:
 *   - Bodies that match the schema pass through unchanged (and lower-case
 *     coercion / defaults apply per the schema's parsing rules).
 *   - Schema failures surface as ValidationError ('VALIDATION_FAILED')
 *     with structured issues — the GlobalExceptionFilter relies on the
 *     {path, code, message} shape to render the openapi-excerpt envelope.
 *   - Non-Zod metatypes (string, Number, Object, undefined) are
 *     pass-through — the pipe must not fight framework-provided types.
 *   - Non-ZodError exceptions are re-raised verbatim (not wrapped) so a
 *     genuine bug stays untouched.
 */
import { ValidationError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import type { ArgumentMetadata } from '@nestjs/common';

class EmailDto {
  // Instance tag keeps `no-extraneous-class` happy — real DTOs (createZodDto)
  // ship with prototype methods, so this just mirrors that shape.
  readonly kind = 'email-dto' as const;
  static readonly schema = z
    .object({
      email: z
        .string()
        .email()
        .transform((v) => v.toLowerCase()),
      keepMe: z.boolean().default(false),
    })
    .strict();
}

const BODY_META: ArgumentMetadata = {
  type: 'body',
  metatype: EmailDto,
  data: undefined,
};

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe();

  it('returns the parsed value when the body matches the schema', () => {
    const out = pipe.transform({ email: 'Jane@Example.com' }, BODY_META);
    expect(out).toEqual({ email: 'jane@example.com', keepMe: false });
  });

  it('throws ValidationError with structured issues when the body fails', () => {
    try {
      pipe.transform({ email: 'not-an-email' }, BODY_META);
      expect.fail('expected ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const details = (err as ValidationError).details;
      const issues = details['issues'];
      expect(Array.isArray(issues)).toBe(true);
      const firstIssue = (issues as ReadonlyArray<Record<string, unknown>>)[0];
      expect(firstIssue?.['path']).toBe('email');
      expect(typeof firstIssue?.['message']).toBe('string');
    }
  });

  it('returns the value untouched when the metatype has no schema', () => {
    const out = pipe.transform(
      { raw: true },
      {
        type: 'body',
        metatype: Object,
        data: undefined,
      },
    );
    expect(out).toEqual({ raw: true });
  });

  it('returns the value untouched when metadata has no metatype at all', () => {
    const out = pipe.transform('passthrough', { type: 'body', data: undefined });
    expect(out).toBe('passthrough');
  });

  it('re-raises non-ZodError exceptions from the schema verbatim', () => {
    class ExplodingDto {
      readonly kind = 'exploding-dto' as const;
      static readonly schema = {
        parse: (): never => {
          throw new TypeError('boom');
        },
      };
    }
    expect(() =>
      pipe.transform(
        {},
        {
          type: 'body',
          metatype: ExplodingDto,
          data: undefined,
        },
      ),
    ).toThrowError(TypeError);
  });
});
