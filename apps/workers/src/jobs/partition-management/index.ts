/**
 * Partition management job barrel — the only surface main.ts imports
 * from. Internal helpers (formatPartitionName, isoWeekStart, the
 * ByteCountingPassThrough) stay private to their modules.
 */
export {
  type ArchiveOutcome,
  type PartitionArchiver,
  type PartitionLifecycleDeps,
  type PartitionLifecycleSummary,
  PartitionLifecycleService,
} from './partition-management.service.js';
export {
  PARTITION_MANAGEMENT_CRON_EXPRESSION,
  PARTITION_MANAGEMENT_CRON_TIMEZONE,
  schedulePartitionManagementJob,
} from './partition-management.scheduler.js';
export { type ParquetArchiverDeps, ParquetPartitionArchiver } from './parquet-archiver.js';
