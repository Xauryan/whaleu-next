import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { globSync, readFileSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const apiDirectory = fileURLToPath(
  new URL('../apps/api/', import.meta.url),
);
export const integrationGlob = 'test/integration/*.test.ts';

export function discoverFiles(directory = apiDirectory) {
  const files = globSync(integrationGlob, { cwd: directory }).sort();
  for (const file of files) {
    if (!statSync(resolve(directory, file)).isFile()) {
      throw new Error(`Integration glob matched a non-file: ${file}`);
    }
  }
  return files;
}

function positiveInteger(value) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Expected a positive safe integer, got ${value}`);
  }
  return Number(value);
}

export function parseArguments(args) {
  if (args.length === 2 && args[0] === '--verify') {
    return { total: positiveInteger(args[1]), list: true };
  }
  if (
    (args.length !== 2 && args.length !== 3) ||
    args[0] !== '--shard' ||
    (args.length === 3 && args[2] !== '--list')
  ) {
    throw new Error('Usage: --verify TOTAL | --shard INDEX/TOTAL [--list]');
  }
  const parts = args[1].split('/');
  if (parts.length !== 2) throw new Error('Expected shard INDEX/TOTAL');
  const index = positiveInteger(parts[0]);
  const total = positiveInteger(parts[1]);
  if (index > total) throw new Error('Shard index exceeds total');
  return { index, total, list: args[2] === '--list' };
}

export function createShardPlan(inputFiles, total) {
  if (!Number.isSafeInteger(total) || total < 1 || total > inputFiles.length) {
    throw new Error(
      'Shard count must be positive and no greater than file count',
    );
  }
  const files = [...inputFiles].sort();
  if (new Set(files).size !== files.length) {
    throw new Error('Duplicate integration input files');
  }
  for (const file of files) {
    if (!/^test\/integration\/[^/]+\.test\.ts$/.test(file)) {
      throw new Error(`Unexpected integration file: ${file}`);
    }
  }
  const shards = Array.from({ length: total }, (_, offset) => ({
    index: offset + 1,
    files: [],
  }));
  for (const file of files) {
    // Hash the filename, not its contents: new files do not move existing files.
    const filename = file.slice('test/integration/'.length);
    const hash = createHash('sha256').update(filename).digest().readUInt32BE(0);
    shards[hash % total].files.push(file);
  }
  if (shards.some((shard) => shard.files.length === 0)) {
    throw new Error('Empty integration shard; choose a smaller shard count');
  }
  const assigned = shards.flatMap((shard) => shard.files).sort();
  if (
    assigned.length !== files.length ||
    new Set(assigned).size !== files.length ||
    assigned.some((file, index) => file !== files[index])
  ) {
    throw new Error('Integration shards must cover the glob exactly once');
  }
  return {
    glob: integrationGlob,
    totalFiles: files.length,
    filesSha256: createHash('sha256').update(files.join('\n')).digest('hex'),
    totalShards: total,
    shards,
  };
}

const postgresImage = 'postgres:18.6-bookworm';
const ownerLabel = 'whaleu.integration.owner';
const clusterLabel = 'whaleu.integration.cluster';
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const postgresCommand = [
  'postgres',
  '-c',
  'listen_addresses=127.0.0.1',
  '-p',
  '5432',
  '-c',
  'autovacuum=off',
];

export function admitPerFileEnvironment(env) {
  if (
    env.CI !== 'true' ||
    env.NODE_ENV !== 'test' ||
    env.WHALEU_TEST_MAINTENANCE !== 'controlled' ||
    env.WHALEU_TEST_PG_ISOLATION !== 'per-file-docker' ||
    env.TEST_DATABASE_URL !==
      'postgresql://whaleu_test:local_ci_only@127.0.0.1:5432/whaleu_test' ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !/^[a-z][a-z0-9-]*$/.test(env.CI_MODULE ?? '') ||
    env.CI_MODULE === 'official-account-browser' ||
    !/^[1-9]\d*\/[1-9]\d*$/.test(env.CI_SHARD ?? '')
  ) {
    throw new Error(
      'Per-file PostgreSQL requires explicit controlled CI admission',
    );
  }
  const index = env.CI_SHARD.split('/')[0];
  const owner = `whaleu-main-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.CI_MODULE}-${index}`;
  if (env.MAIN_PG_CONTAINER !== owner)
    throw new Error('Unexpected per-file PostgreSQL job owner');
  return owner;
}

function command(spawn, executable, args, options = {}) {
  const result = spawn(executable, args, {
    encoding: 'utf8',
    timeout: 60000,
    killSignal: 'SIGKILL',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0)
    throw new Error(
      `${executable} ${args[0]} failed (${result.status}/${result.signal ?? 'none'})`,
    );
  return result.stdout?.trim() ?? '';
}

export function inspectOwnedContainer(
  id,
  owner,
  spawn = spawnSync,
  expectedNonce,
) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Full container ID required');
  const rows = JSON.parse(
    command(spawn, 'docker', ['inspect', id], { timeout: 10000 }),
  );
  const state = rows[0];
  const nonce = state?.Config?.Labels?.[clusterLabel];
  if (
    rows.length !== 1 ||
    state?.Id !== id ||
    !uuidPattern.test(nonce ?? '') ||
    (expectedNonce !== undefined && nonce !== expectedNonce) ||
    state.Name !== `/${owner}-${nonce}` ||
    state.Config?.Labels?.[ownerLabel] !== owner ||
    state.Config?.Image !== postgresImage ||
    state.HostConfig?.NetworkMode !== 'host' ||
    JSON.stringify(state.Config?.Cmd) !==
      JSON.stringify([
        ...postgresCommand,
        '-c',
        `cluster_name=whaleu-${nonce}`,
      ]) ||
    (state.HostConfig?.Binds?.length ?? 0) !== 0 ||
    (state.HostConfig?.Mounts?.length ?? 0) !== 0 ||
    !Array.isArray(state.Mounts) ||
    state.Mounts.length !== 1 ||
    state.Mounts.some(
      (mount) =>
        mount.Type !== 'volume' ||
        !/^[a-f0-9]{64}$/.test(mount.Name ?? '') ||
        // PostgreSQL 18 uses VOLUME=/var/lib/postgresql, not the pre-18 /data.
        mount.Destination !== '/var/lib/postgresql',
    )
  ) {
    throw new Error('Refusing unowned or unexpected PostgreSQL container');
  }
  return state;
}

function verifyOwnedEndpoint(id, owner, nonce, env, spawn) {
  const assertRunning = () => {
    const state = inspectOwnedContainer(id, owner, spawn, nonce);
    if (!state.State?.Running || state.State?.Health?.Status !== 'healthy')
      throw new Error('Owned per-file PostgreSQL is not running and healthy');
  };
  assertRunning();
  // The same URL and driver as freshness admission; no fixture or migration SQL.
  // A healthy unrelated host listener cannot know this newly generated marker.
  const marker = command(
    spawn,
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL,
  connectionTimeoutMillis: 5000, statement_timeout: 5000 });
try {
  await client.connect();
  const { rows } = await client.query("SELECT current_setting('cluster_name') AS marker");
  process.stdout.write(rows[0].marker);
} finally { await client.end(); }
`,
    ],
    { cwd: apiDirectory, env, timeout: 10000 },
  );
  if (marker !== `whaleu-${nonce}`)
    throw new Error(
      'PostgreSQL endpoint does not belong to the owned file container',
    );
  // Reject a stop/replacement while the independent endpoint probe was running.
  assertRunning();
}

export function cleanupPerFileContainers(env = process.env, spawn = spawnSync) {
  const owner = admitPerFileEnvironment(env);
  const ids = command(spawn, 'docker', [
    'ps',
    '--all',
    '--quiet',
    '--no-trunc',
    '--filter',
    `label=${ownerLabel}=${owner}`,
  ])
    .split('\n')
    .filter(Boolean);
  for (const id of ids) {
    inspectOwnedContainer(id, owner, spawn);
    command(spawn, 'docker', ['rm', '--force', '--volumes', id]);
  }
  return 0;
}

export function runIsolatedTests(
  files,
  spawn = spawnSync,
  {
    env = process.env,
    write = console.log,
    read = readFileSync,
    uuid = randomUUID,
    now = Date.now,
    sleep = () =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000),
  } = {},
) {
  const owner = admitPerFileEnvironment(env);
  if (
    !files.length ||
    new Set(files).size !== files.length ||
    files.some(
      (file) => !/^test\/integration\/[a-z0-9][a-z0-9-]*\.test\.ts$/.test(file),
    )
  )
    throw new Error('Invalid per-file integration inventory');
  // Hash the entire selected source set before creating any disposable service.
  const records = files.map((file) => ({
    file,
    fileSourceSha256: createHash('sha256')
      .update(read(resolve(apiDirectory, file)))
      .digest('hex'),
    sourceSha: env.GITHUB_SHA,
    owner,
  }));
  let aggregate = 0;
  for (const record of records) {
    const token = uuid();
    if (!uuidPattern.test(token)) throw new Error('Invalid container nonce');
    const name = `${owner}-${token}`;
    let id, status, failure;
    write(
      JSON.stringify({
        perFilePostgres: 'start',
        ...record,
        containerName: name,
      }),
    );
    try {
      id = command(spawn, 'docker', [
        'create',
        '--name',
        name,
        '--label',
        `${ownerLabel}=${owner}`,
        '--label',
        `${clusterLabel}=${token}`,
        '--network',
        'host',
        '--shm-size=256m',
        '--env',
        'POSTGRES_USER=whaleu_test',
        '--env',
        'POSTGRES_PASSWORD=local_ci_only',
        '--env',
        'POSTGRES_DB=whaleu_test',
        '--health-cmd',
        'pg_isready -h 127.0.0.1 -p 5432 -U whaleu_test -d whaleu_test',
        '--health-interval',
        '1s',
        '--health-timeout',
        '3s',
        '--health-retries',
        '60',
        postgresImage,
        ...postgresCommand,
        '-c',
        `cluster_name=whaleu-${token}`,
      ]);
      inspectOwnedContainer(id, owner, spawn, token);
      command(spawn, 'docker', ['start', id]);
      const deadline = now() + 60000;
      while (true) {
        const state = inspectOwnedContainer(id, owner, spawn, token);
        if (state.State?.Running && state.State?.Health?.Status === 'healthy')
          break;
        if (
          !state.State?.Running ||
          state.State?.Health?.Status === 'unhealthy' ||
          now() >= deadline
        )
          throw new Error('Fresh per-file PostgreSQL did not become ready');
        sleep();
      }
      const childEnv = { ...env, MAIN_PG_CONTAINER: id };
      verifyOwnedEndpoint(id, owner, token, childEnv, spawn);
      command(
        spawn,
        process.execPath,
        [fileURLToPath(new URL('./verify-test-postgres.mjs', import.meta.url))],
        {
          env: childEnv,
          stdio: 'inherit',
        },
      );
      const assertSourceUnchanged = () => {
        const actual = createHash('sha256')
          .update(read(resolve(apiDirectory, record.file)))
          .digest('hex');
        if (actual !== record.fileSourceSha256)
          throw new Error(`Integration source changed: ${record.file}`);
      };
      verifyOwnedEndpoint(id, owner, token, childEnv, spawn);
      assertSourceUnchanged();
      const result = spawn(
        process.execPath,
        ['--import', 'tsx', '--test', '--test-concurrency=1', record.file],
        { cwd: apiDirectory, stdio: 'inherit', env: childEnv },
      );
      assertSourceUnchanged();
      if (result.error) throw result.error;
      if (result.signal) {
        status = 128 + constants.signals[result.signal];
        throw new Error(`Integration file terminated by ${result.signal}`);
      }
      if (!Number.isInteger(result.status))
        throw new Error('Missing test exit status');
      status = result.status;
      if (status !== 0) aggregate = status;
    } catch (error) {
      failure = error;
    } finally {
      if (id) {
        try {
          inspectOwnedContainer(id, owner, spawn, token);
          if (failure || status !== 0)
            command(spawn, 'docker', ['logs', id], { stdio: 'inherit' });
        } catch (error) {
          failure ??= error;
        }
        try {
          // Re-admit immediately before deletion; never clean an unknown target.
          inspectOwnedContainer(id, owner, spawn, token);
          command(spawn, 'docker', ['rm', '--force', '--volumes', id]);
        } catch (error) {
          failure ??= error;
        }
      }
      write(
        JSON.stringify({
          perFilePostgres: 'end',
          ...record,
          containerId: id ?? null,
          status: status ?? null,
          outcome: failure
            ? 'infrastructure-failure'
            : status === 0
              ? 'passed'
              : 'failed',
          ...(failure ? { error: failure.message } : {}),
        }),
      );
    }
    if (failure) throw failure;
  }
  return aggregate;
}

export function runTests(files, spawn = spawnSync, { reporter } = {}) {
  if (files.length === 0) throw new Error('Refusing to run an empty shard');
  if (reporter !== undefined && reporter !== 'tap')
    throw new Error('Unsupported integration reporter');
  if (process.env.WHALEU_TEST_PG_ISOLATION !== undefined) {
    if (reporter !== undefined)
      throw new Error('Browser reporter must not use per-file isolation');
    return runIsolatedTests(files, spawn);
  }
  const result = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      ...(reporter ? [`--test-reporter=${reporter}`] : []),
      ...files,
    ],
    { cwd: apiDirectory, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.signal) return 128 + constants.signals[result.signal];
  if (!Number.isInteger(result.status))
    throw new Error('Missing test exit status');
  return result.status;
}

export function main(
  args,
  { files = discoverFiles(), write = console.log, run = runTests } = {},
) {
  const options = parseArguments(args);
  const plan = createShardPlan(files, options.total);
  const selected =
    options.index === undefined
      ? plan.shards
      : [plan.shards[options.index - 1]];
  // Every job logs its exact file manifest and the same complete-corpus digest.
  write(
    JSON.stringify({
      ...plan,
      selectedFiles: selected.reduce(
        (count, shard) => count + shard.files.length,
        0,
      ),
      shards: selected,
    }),
  );
  if (options.list) return 0;
  return run(selected[0].files);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    process.exitCode =
      args.length === 1 && args[0] === '--cleanup-per-file'
        ? cleanupPerFileContainers()
        : main(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
