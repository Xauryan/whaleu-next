import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { poolOptions } from '../../src/database/database.js';
import { configureHttp } from '../../src/http/http.js';
import { bindOfficialFixtureRuntime } from './official-account-fixture.js';
import type { officialAccountFixture } from './official-account-fixture.js';
import { startOfficialRestorePostgres } from './official-account-restore-postgres.js';

/** Complete disposable DB + file adapter restore. Caller has stopped all writes;
 * no selective ledger seed, trigger disabling, or production database is allowed. */
export async function restoreOfficialFixture(
  source: Awaited<ReturnType<typeof officialAccountFixture>>,
) {
  const original = source.app.get<RuntimeConfig>(APP_CONFIG);
  const url = new URL(original.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  assert.equal(original.NODE_ENV, 'test');
  const directory = await mkdtemp(join(tmpdir(), 'whaleu-official-restore-'));
  let preserveFiles = false;
  let cluster:
      Awaited<ReturnType<typeof startOfficialRestorePostgres>> | undefined,
    app: INestApplication | undefined,
    pool: Pool | undefined;
  const closeRuntime = async () => {
    const currentApp = app,
      currentPool = pool;
    app = undefined;
    pool = undefined;
    try {
      await currentApp?.close();
    } finally {
      await currentPool?.end();
    }
  };
  const cleanup = async () => {
    try {
      await closeRuntime();
    } finally {
      await cluster?.close();
      if (!preserveFiles) await rm(directory, { recursive: true, force: true });
    }
  };
  const run = async (
    tool: 'pg_dump' | 'pg_restore',
    args: string[],
    input: string | undefined,
    output: string | undefined,
    container: string | undefined,
  ) => {
    if (container) assert.match(container, /^[A-Za-z0-9_.-]+$/);
    const command = container ? 'docker' : tool;
    const commandArgs = container
      ? ['exec', ...(input ? ['-i'] : []), container, tool, ...args]
      : args;
    const stdin = input ? await open(input, 'r') : undefined;
    const stdout = output ? await open(output, 'wx') : undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, commandArgs, {
          stdio: [stdin?.fd ?? 'ignore', stdout?.fd ?? 'ignore', 'pipe'],
          timeout: 120000,
        });
        let error = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          if (error.length < 16384) error += chunk.toString('utf8');
        });
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          code === 0
            ? resolve()
            : reject(new Error(`${tool} failed (${code}/${signal}): ${error}`)),
        );
      });
    } finally {
      await stdin?.close();
      await stdout?.close();
    }
  };
  try {
    const dump = join(directory, 'fixture.dump'),
      adapter = join(directory, 'adapter');
    await run(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--dbname',
        url.href,
      ],
      undefined,
      dump,
      process.env['MAIN_PG_CONTAINER'],
    );
    await cp(source.directory, adapter, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    cluster = await startOfficialRestorePostgres(directory);
    const targetUrl = new URL(cluster.connectionString);
    assert.equal(targetUrl.pathname, '/whaleu_test');
    await cluster.verify();
    await run(
      'pg_restore',
      [
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        ...cluster.restoreConnectionArgs,
      ],
      dump,
      undefined,
      cluster.container,
    );
    await cluster.verify();
    const config = { ...original, DATABASE_URL: targetUrl.href };
    const connectRuntime = async () => {
      pool = new Pool(poolOptions(config));
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      }).compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.listen(0, '127.0.0.1');
      return {
        ...bindOfficialFixtureRuntime(
          app,
          adapter,
          source.runtime.fixtureEpoch,
        ),
        app,
        pool,
        directory: adapter,
      };
    };
    const connected = await connectRuntime();
    const snapshotBytes = await readFile(dump);
    process.stdout.write(
      JSON.stringify({
        officialRestore: 'complete-disposable-database-and-adapter',
        snapshotBytes: snapshotBytes.length,
        snapshotSHA256: createHash('sha256')
          .update(snapshotBytes)
          .digest('hex'),
        databaseName: 'whaleu_test',
        separateLoopbackPort: targetUrl.port,
      }) + '\n',
    );
    const restored = {
      ...connected,
      close: cleanup,
      restart: async () => {
        try {
          await closeRuntime();
          // Only this owned secondary cluster is restarted, after every application
          // and direct fixture pool has closed. Data and adapter files stay intact.
          await cluster!.restart();
          Object.assign(restored, await connectRuntime());
        } catch (error) {
          preserveFiles = true;
          process.stderr.write(
            `Official restart failure files preserved: ${directory}\n`,
          );
          throw error;
        }
      },
    };
    return restored;
  } catch (error) {
    preserveFiles = true;
    process.stderr.write(
      `Official restore failure files preserved: ${directory}\n`,
    );
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Official fixture restore and cleanup failed',
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
