/**
 * Vitest globalSetup — boots one Redis 7 testcontainer per vitest run and
 * exposes its connection URL as REDIS_TEST_URL. The per-spec harness then
 * connects an ioredis client against this URL.
 *
 * Mirrors the singleFork + container-once pattern used by apps/workers and
 * apps/api so the realtime suite stays predictable under CI parallelism.
 */
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

let container: StartedTestContainer | undefined;

export default async function (): Promise<() => Promise<void>> {
  container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withStartupTimeout(60_000)
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(6379);
  process.env['REDIS_TEST_URL'] = `redis://${host}:${String(port)}`;
  return async () => {
    if (container !== undefined) {
      await container.stop();
      container = undefined;
    }
  };
}
