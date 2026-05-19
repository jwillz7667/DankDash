/**
 * Global validation pipe — coerces incoming bodies/queries/params into the
 * Zod schema attached to the controller parameter via nestjs-zod's
 * `ZodDto`. nestjs-zod ships its own validation pipe but this thin wrapper
 * gives us:
 *
 *   1. A single place to translate ZodError -> our typed DomainError, so
 *      the GlobalExceptionFilter can emit the openapi-excerpt envelope
 *      consistently with other validation failures (DTOs, env, custom).
 *   2. Pass-through for non-Zod metatypes (primitives, framework-provided
 *      types) — the pipe is non-destructive when no schema is present.
 */
import { ValidationError } from '@dankdash/types';
import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodSchema } from 'zod';

interface MaybeZodDto {
  readonly schema?: ZodSchema;
}

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = this.resolveSchema(metadata);
    if (schema === undefined) return value;
    try {
      return schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError('Request validation failed', {
          issues: err.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
        });
      }
      throw err;
    }
  }

  private resolveSchema(metadata: ArgumentMetadata): ZodSchema | undefined {
    const meta = metadata.metatype as MaybeZodDto | undefined;
    return meta?.schema;
  }
}
