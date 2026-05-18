/**
 * Liveness + readiness probes for Railway and any future k8s-style
 * orchestrator. Excluded from the /v1 global prefix so the platform can
 * probe the process unconditionally; deliberately auth-free.
 *
 * GET /health         -> 200 if the process is running
 * GET /health/live    -> alias, used by Railway healthcheck
 * GET /health/ready   -> 200 once the app has finished bootstrapping
 *                       (Postgres + Redis checks are added in later phases
 *                       when those modules are wired)
 */
import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';

interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'apps/api';
  readonly checkedAt: string;
}

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  health(): HealthResponse {
    return this.payload();
  }

  @Public()
  @Get('health/live')
  live(): HealthResponse {
    return this.payload();
  }

  @Public()
  @Get('health/ready')
  ready(): HealthResponse {
    return this.payload();
  }

  private payload(): HealthResponse {
    return { status: 'ok', service: 'apps/api', checkedAt: new Date().toISOString() };
  }
}
