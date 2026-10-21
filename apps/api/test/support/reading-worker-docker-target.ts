/** Test-only target binding supplied by the owned Docker sandbox after inspecting
 * its exact ID, owner label, sole bridge address and loopback published port.
 * JSON is not independent ownership evidence; never consumed by runtime or
 * implicitly read from process.env by a reusable role helper. */
import assert from 'node:assert/strict';
import { isIP } from 'node:net';

export interface ReadingWorkerDockerTarget {
  readonly version: 1;
  readonly containerId: string;
  readonly owner: string;
  readonly serverAddress: string;
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly database: 'whaleu_test';
}
// Reject a structural object passed directly around the one explicit decoder.
// This marks test validation only, not DB/runtime authority or Docker ownership.
const decoded = new WeakSet<ReadingWorkerDockerTarget>();
export function readingWorkerDockerTarget(
  raw: string | undefined,
  database: string,
  authMode: 'trust' | 'password',
): ReadingWorkerDockerTarget | undefined {
  if (raw === undefined) return undefined;
  assert.equal(
    authMode,
    'password',
    'Docker target requires explicit password lane',
  );
  assert.ok(
    raw.length > 0 && raw.length <= 1024,
    'Invalid Docker target metadata',
  );
  const value: unknown = JSON.parse(raw);
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
  );
  assert.equal(
    Object.keys(value).sort().join(','),
    'containerId,database,host,owner,port,serverAddress,version',
  );
  assert.ok('version' in value && value.version === 1);
  assert.ok(
    'containerId' in value &&
      typeof value.containerId === 'string' &&
      /^[a-f0-9]{64}$/.test(value.containerId),
  );
  assert.ok(
    'owner' in value &&
      typeof value.owner === 'string' &&
      /^[a-f0-9]{32}$/.test(value.owner),
  );
  assert.ok(
    'serverAddress' in value &&
      typeof value.serverAddress === 'string' &&
      isIP(value.serverAddress) === 4,
  );
  assert.ok('host' in value && value.host === '127.0.0.1');
  assert.ok(
    'port' in value &&
      typeof value.port === 'number' &&
      Number.isInteger(value.port) &&
      value.port >= 1 &&
      value.port <= 65535,
  );
  assert.ok('database' in value && value.database === 'whaleu_test');
  const url = new URL(database);
  assert.ok(url.protocol === 'postgres:' || url.protocol === 'postgresql:');
  assert.equal(url.hostname, value.host);
  assert.equal(url.port, String(value.port));
  assert.equal(url.pathname, '/' + value.database);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  const target: ReadingWorkerDockerTarget = Object.freeze({
    version: value.version,
    containerId: value.containerId,
    owner: value.owner,
    serverAddress: value.serverAddress,
    host: value.host,
    port: value.port,
    database: value.database,
  });
  decoded.add(target);
  return target;
}
export function assertReadingWorkerTarget(
  actual: { database: string; host: string | null },
  docker?: ReadingWorkerDockerTarget,
): void {
  assert.equal(actual.database, 'whaleu_test');
  if (docker !== undefined) {
    assert.ok(
      decoded.has(docker),
      'Docker target must pass the explicit CLI fixture decoder',
    );
    assert.equal(
      actual.host,
      docker.serverAddress,
      'Database server differs from inspected owned Docker address',
    );
  } else {
    // Preserve the exact existing local/socket guard. No env or network inference.
    assert.ok(
      actual.host === null || ['127.0.0.1', '::1'].includes(actual.host),
    );
  }
}
