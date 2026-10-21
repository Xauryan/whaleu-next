/** Test-only real Node CLI transport. No Nest/bootstrap replacement and no shell.
 * Raw child output is never returned or printed, even on failure. */
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface ReadingCliHealth {
  readonly worker: 'reading-formatting';
  readonly state:
    'starting' | 'running' | 'sleeping' | 'stopping' | 'stopped' | 'failed';
  readonly cycles: number;
  readonly ticks: number;
}
export function decodeReadingCliHealth(value: unknown): ReadingCliHealth {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid bounded reading health');
  if (Object.keys(value).sort().join(',') !== 'cycles,state,ticks,worker')
    throw new Error('Invalid bounded reading health');
  if (
    !('worker' in value) ||
    value.worker !== 'reading-formatting' ||
    !('state' in value) ||
    (value.state !== 'starting' &&
      value.state !== 'running' &&
      value.state !== 'sleeping' &&
      value.state !== 'stopping' &&
      value.state !== 'stopped' &&
      value.state !== 'failed') ||
    !('cycles' in value) ||
    typeof value.cycles !== 'number' ||
    !Number.isSafeInteger(value.cycles) ||
    value.cycles < 0 ||
    !('ticks' in value) ||
    typeof value.ticks !== 'number' ||
    !Number.isSafeInteger(value.ticks) ||
    value.ticks < 0
  )
    throw new Error('Invalid bounded reading health');
  return Object.freeze({
    worker: value.worker,
    state: value.state,
    cycles: value.cycles,
    ticks: value.ticks,
  });
}
export function readingCliCommand(
  apiRoot: string,
  entry: 'source' | 'compiled',
  mode: 'once' | 'serve',
) {
  if (
    !isAbsolute(apiRoot) ||
    !['source', 'compiled'].includes(entry) ||
    !['once', 'serve'].includes(mode)
  )
    throw new Error('Invalid reading CLI test command');
  return Object.freeze({
    cwd: apiRoot,
    args:
      entry === 'source'
        ? [
            '--import',
            'tsx',
            join(
              apiRoot,
              'src/community/reading-formatting/process-reading.ts',
            ),
            mode,
          ]
        : [
            join(
              apiRoot,
              'dist/community/reading-formatting/process-reading.js',
            ),
            mode,
          ],
  });
}
export function readingCliEnvironment(
  apiRoot: string,
  database: string,
  mode: 'once' | 'serve',
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  // No dotenv file, NODE_OPTIONS, provider credential, API token or inherited
  // automatic owner setting is delivered to this standalone fixture process.
  return {
    ...(inherited['PATH'] ? { PATH: inherited['PATH'] } : {}),
    ...(inherited['NODE_EXTRA_CA_CERTS']
      ? { NODE_EXTRA_CA_CERTS: inherited['NODE_EXTRA_CA_CERTS'] }
      : {}),
    TSX_TSCONFIG_PATH: join(apiRoot, 'tsconfig.json'),
    NODE_ENV: 'production',
    DATABASE_URL: database,
    PG_SSL_MODE: 'verify-full',
    LOG_LEVEL: 'silent',
    PG_POOL_MAX: '1',
    PG_CONNECTION_TIMEOUT_MS: '5000',
    PG_STATEMENT_TIMEOUT_MS: '10000',
    COMMUNITY_READING_FORMATTING_PROCESSING:
      mode === 'serve' ? 'automatic' : 'manual_only',
    COMMUNITY_READING_FORMATTING_INTERVAL_MS: '1000',
    COMMUNITY_READING_FORMATTING_TICKS_PER_CYCLE: '1',
    COMMUNITY_TEXT_REVIEW: 'disabled',
    COMMUNITY_UPDATES_PROCESSING: 'disabled',
    EXPERIENCE_PROCESSING: 'disabled',
    VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
  };
}
const expectedError =
  'Reading worker failed; check explicit mode, schema readiness and managed-runtime role\n';
export function startReadingCli(
  apiRoot: string,
  entry: 'source' | 'compiled',
  mode: 'once' | 'serve',
  env: NodeJS.ProcessEnv,
) {
  const command = readingCliCommand(apiRoot, entry, mode);
  const child = spawn(process.execPath, command.args, {
    cwd: command.cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const health: ReadingCliHealth[] = [];
  let buffer = '',
    stderr = '',
    bytes = 0,
    closed = false,
    problem: string | null = null;
  let drain: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!closed && child.pid)
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* Already exited. */
      }
  };
  const stop = () => {
    kill('SIGTERM');
    if (!closed && !drain)
      drain = setTimeout(() => {
        problem ??= 'drain_deadline';
        kill('SIGKILL');
      }, 10000);
  };
  const deadline = setTimeout(() => {
    problem ??= 'child_deadline';
    kill('SIGKILL');
  }, 30000);
  const fail = () => {
    problem ??= 'child_output';
    stop();
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 65536) {
      fail();
      return;
    }
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'),
        line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (problem) continue;
      try {
        health.push(decodeReadingCliHealth(JSON.parse(line)));
      } catch {
        fail();
      }
    }
  });
  child.stderr.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 65536) {
      fail();
      return;
    }
    stderr += chunk;
  });
  child.on('error', () => {
    problem ??= 'child_spawn';
  });
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    problem: string | null;
    stderr: 'empty' | 'expected_failure' | 'unexpected';
    health: readonly ReadingCliHealth[];
  }>((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(deadline);
      if (drain) clearTimeout(drain);
      if (buffer.length) problem ??= 'partial_health';
      const kind =
        stderr === ''
          ? 'empty'
          : stderr === expectedError
            ? 'expected_failure'
            : 'unexpected';
      if (kind === 'unexpected') problem ??= 'child_output';
      resolve({ code, signal, problem, stderr: kind, health: [...health] });
    });
  });
  return {
    done,
    async waitFor(predicate: (value: ReadingCliHealth) => boolean) {
      while (!closed) {
        const found = health.find(predicate);
        if (found) return found;
        await sleep(5);
      }
      throw new Error(
        'Reading CLI closed before required bounded health phase',
      );
    },
    async stop() {
      stop();
      return done;
    },
  };
}
