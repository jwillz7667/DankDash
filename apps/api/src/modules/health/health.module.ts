import { Module } from '@nestjs/common';
import { MetricsController } from '../../infrastructure/metrics.controller.js';
import { HealthController } from './health.controller.js';

@Module({
  controllers: [HealthController, MetricsController],
})
export class HealthModule {}
