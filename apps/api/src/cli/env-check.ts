#!/usr/bin/env node
/**
 * `pnpm --filter @dankdash/api run env-check`
 *
 * Loads the current process env via `loadEnv()` (failing fast on
 * schema violations), then runs the production-strict overlay from
 * `@dankdash/config`. Referenced by `docs/LAUNCH-CHECKLIST.md` §2.3
 * as the gate the platform lead runs against the populated
 * `.env.production` before launch.
 *
 * Exit codes:
 *   0  — all checks pass
 *   2  — one or more checks failed (failures printed to stderr)
 *   1  — unexpected runtime error (printed verbatim)
 *
 * The pure check functions live in `@dankdash/config/env-check`;
 * their unit tests live alongside them and run without testcontainers.
 */
import {
  type Env,
  EnvValidationError,
  formatIssueReport,
  loadEnv,
  runAllChecks,
} from '@dankdash/config';

function main(): void {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err: unknown) {
    if (err instanceof EnvValidationError) {
      const report = formatIssueReport(
        err.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      );
      process.stderr.write(`${report}\n(schema validation failed before strict checks ran)\n`);
      process.exit(2);
    }
    throw err;
  }

  const issues = runAllChecks(env);
  if (issues.length === 0) {
    process.stdout.write(`env-check: ok (NODE_ENV=${env.NODE_ENV})\n`);
    process.exit(0);
  }

  process.stderr.write(formatIssueReport(issues));
  process.exit(2);
}

try {
  main();
} catch (err: unknown) {
  process.stderr.write(`env-check fatal: ${String(err)}\n`);
  process.exit(1);
}
