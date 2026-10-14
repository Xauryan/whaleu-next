import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
const execute = promisify(execFile);

interface CaptureIdentity {
  system: string;
  started: string;
  directory: string;
  clients: number;
}
const identityColumns = `current_setting('data_directory') directory,
 (SELECT system_identifier::text FROM pg_control_system()) system,
 extract(epoch FROM pg_postmaster_start_time())::text started,
 (SELECT count(*)::int FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type='client backend') clients`;
function sameCluster(before: CaptureIdentity, after: CaptureIdentity) {
  assert.equal(after.system, before.system, 'Restore cluster identity changed');
  assert.equal(
    after.directory,
    before.directory,
    'Restore data directory changed',
  );
}
async function waitUntilReady(verify: () => Promise<unknown>) {
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      await verify();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** A second controlled loopback cluster, always named whaleu_test. Production
 * owner guards remain intact. This fixture is tiny and separate from scale data.
 * Only the short 0700 Unix IPC directory is in /tmp (socket path length limit);
 * PG data/logs stay under the workspace TMPDIR. The wrapper removes that directory
 * only after confirmed shutdown. Restore never reconnects through a reusable TCP
 * port: it uses the verified container/private Unix socket. */
export async function startOfficialRestorePostgres(directory: string) {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const docker = !!process.env['MAIN_PG_CONTAINER'];
  const marker = randomUUID();
  const container = docker ? `whaleu-official-restore-${marker}` : undefined;
  const clusterDirectory = join(directory, 'postgres');
  await mkdir(clusterDirectory);
  const connectionString = `postgresql://whaleu_test@127.0.0.1:${port}/whaleu_test`;
  let log = '';
  const append = (chunk: Buffer) => {
    if (log.length < 262144) log += chunk.toString('utf8');
  };
  let identity: CaptureIdentity | undefined;
  if (container) {
    assert.notEqual(container, process.env['MAIN_PG_CONTAINER']);
    let containerId: string | undefined;
    const inspect = async () => {
      const result = await execute(
        'docker',
        [
          'inspect',
          '--format',
          '{{.Id}} {{.State.Running}} {{index .Config.Labels "whaleu.restore.fixture"}}',
          container,
        ],
        { timeout: 10000, maxBuffer: 16384 },
      );
      return result.stdout.trim();
    };
    const close = async () => {
      let status: string;
      try {
        status = await inspect();
      } catch (error) {
        if (
          String(error).includes('No such object') &&
          String(error).includes(container)
        )
          return;
        throw error;
      }
      assert.equal(
        status.split(' ')[2],
        marker,
        'Refuse cleanup of an unowned restore container',
      );
      const ownedId = status.split(' ')[0]!;
      assert.match(ownedId, /^[a-f0-9]{64}$/);
      if (containerId) assert.equal(ownedId, containerId);
      const logs = await execute('docker', ['logs', ownedId], {
        timeout: 10000,
        maxBuffer: 262144,
      }).catch((error) => ({ stdout: '', stderr: String(error) }));
      await writeFile(
        join(directory, 'restore-postgres.log'),
        logs.stdout + logs.stderr,
      );
      await execute('docker', ['rm', '--force', '--volumes', ownedId], {
        timeout: 30000,
      });
    };
    const verify = async (restartedFrom?: CaptureIdentity) => {
      assert.ok(containerId);
      assert.equal(
        await inspect(),
        `${containerId} true ${marker}`,
        'Restore container must remain owned and running',
      );
      const probe = new Pool({
        connectionString,
        connectionTimeoutMillis: 1000,
        max: 1,
      });
      try {
        const row = (
          await probe.query<
            CaptureIdentity & {
              version: number;
              marker: string | null;
              database: string;
            }
          >(
            `SELECT current_setting('server_version_num')::int version,current_setting('whaleu.official_restore_id',true) marker,current_database() database,${identityColumns}`,
          )
        ).rows[0]!;
        assert.equal(row.version, 180006);
        assert.equal(
          row.marker,
          marker,
          'Restore port belongs to another cluster',
        );
        assert.equal(row.database, 'whaleu_test');
        if (identity) {
          sameCluster(identity, row);
          if (restartedFrom)
            assert.notEqual(row.started, restartedFrom.started);
          else assert.equal(row.started, identity.started);
        }
        identity = row;
        return row;
      } finally {
        await probe.end();
      }
    };
    try {
      const launched = await execute(
        'docker',
        [
          'run',
          '--detach',
          '--pull=never',
          '--name',
          container,
          '--label',
          `whaleu.restore.fixture=${marker}`,
          '--network',
          'host',
          '--shm-size=128m',
          '--memory=512m',
          '--cpus=2',
          '--cpuset-cpus=0,1',
          '--env',
          'POSTGRES_USER=whaleu_test',
          '--env',
          'POSTGRES_HOST_AUTH_METHOD=trust',
          '--env',
          'POSTGRES_DB=whaleu_test',
          'postgres:18.6-bookworm',
          'postgres',
          '-c',
          'listen_addresses=127.0.0.1',
          '-p',
          String(port),
          '-c',
          'autovacuum=off',
          '-c',
          `whaleu.official_restore_id=${marker}`,
        ],
        { timeout: 30000 },
      );
      containerId = launched.stdout.trim();
      assert.match(containerId, /^[a-f0-9]{64}$/);
      await waitUntilReady(() => verify());
      const restart = async () => {
        const before = await verify();
        assert.equal(
          before.clients,
          0,
          'Close all restore clients before restart',
        );
        // The exact UUID-labelled secondary container retains its data volume.
        // Never stop/restart MAIN_PG_CONTAINER or target a reusable container name.
        await execute('docker', ['restart', '--time=30', containerId!], {
          timeout: 60000,
        });
        await waitUntilReady(() => verify(before));
      };
      return {
        connectionString,
        container: containerId,
        verify: () => verify(),
        restart,
        close,
        restoreConnectionArgs: [
          '--host=/var/run/postgresql',
          `--port=${port}`,
          '--username=whaleu_test',
          '--dbname=whaleu_test',
        ],
      };
    } catch (error) {
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Restore cluster startup and cleanup failed',
          { cause: cleanup },
        );
      }
      throw error;
    }
  }
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, 'scripts/run-controlled-test-postgres.sh'))) {
    const parent = dirname(root);
    assert.notEqual(parent, root, 'Controlled PostgreSQL wrapper is required');
    root = parent;
  }
  const script = join(root, 'scripts/run-controlled-test-postgres.sh');
  const child = spawn(
    'bash',
    [
      script,
      'node',
      '--input-type=module',
      '-e',
      "process.stdout.write('OFFICIAL_RESTORE_PG_READY\\n'); process.stdin.resume();",
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WHALEU_TEST_MAINTENANCE: 'controlled',
        WHALEU_TEST_PG_PRIVATE_SOCKET: '1',
        WHALEU_TEST_PG_PORT: String(port),
        TMPDIR: clusterDirectory,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let finished = false;
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      finished = true;
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Controlled restore PostgreSQL exited ${code}/${signal}: ${log}`,
          ),
        );
    });
  });
  // Attach a rejection handler immediately; startup and shutdown both await it.
  void completion.catch(() => undefined);
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const close = async () => {
    child.stdin.end();
    const timer = setTimeout(() => {
      if (!finished) child.kill('SIGTERM');
    }, 30000);
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          hardTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `Restore PostgreSQL shutdown not confirmed; preserve ${clusterDirectory}: ${log}`,
                ),
              ),
            90000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearTimeout(hardTimer);
      await writeFile(join(directory, 'restore-postgres.log'), log);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Restore PostgreSQL startup timeout: ${log}`));
      }, 60000);
      const inspect = () => {
        if (log.includes('OFFICIAL_RESTORE_PG_READY\n')) {
          clearTimeout(timer);
          child.stdout.off('data', inspect);
          resolve();
        }
      };
      child.stdout.on('data', inspect);
      void completion.then(
        () => {
          clearTimeout(timer);
          reject(new Error('Restore PostgreSQL exited before ready'));
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    let socketDirectory: string | undefined;
    const verify = async (restartedFrom?: CaptureIdentity) => {
      assert.equal(finished, false, 'Controlled restore wrapper exited');
      const probe = new Pool({
        connectionString,
        connectionTimeoutMillis: 1000,
        max: 1,
      });
      try {
        const row = (
          await probe.query<
            CaptureIdentity & {
              database: string;
              socket: string;
            }
          >(
            `SELECT current_database() database,current_setting('unix_socket_directories') socket,${identityColumns}`,
          )
        ).rows[0]!;
        assert.ok(
          row.directory.startsWith(clusterDirectory + '/whaleu-controlled-pg.'),
          'Restore port belongs to another cluster',
        );
        assert.equal(row.database, 'whaleu_test');
        assert.match(row.socket, /^\/tmp\/whaleu-pg-socket\.[A-Za-z0-9]+$/);
        if (socketDirectory) assert.equal(row.socket, socketDirectory);
        socketDirectory = row.socket;
        if (identity) {
          sameCluster(identity, row);
          if (restartedFrom)
            assert.notEqual(row.started, restartedFrom.started);
          else assert.equal(row.started, identity.started);
        }
        identity = row;
        return row;
      } finally {
        await probe.end();
      }
    };
    await verify();
    assert.ok(socketDirectory);
    const restart = async () => {
      const before = await verify();
      assert.equal(
        before.clients,
        0,
        'Close all restore clients before restart',
      );
      assert.match(
        before.directory.slice(
          (clusterDirectory + '/whaleu-controlled-pg.').length,
        ),
        /^[A-Za-z0-9]+\/data$/,
      );
      const bin = process.env['WHALEU_TEST_PG_BIN'];
      await execute(
        bin ? join(bin, 'pg_ctl') : 'pg_ctl',
        [
          '-D',
          before.directory,
          '-l',
          join(dirname(before.directory), 'postgres.log'),
          '-m',
          'fast',
          '-w',
          'restart',
        ],
        { timeout: 60000 },
      );
      await waitUntilReady(() => verify(before));
    };
    return {
      connectionString,
      container: undefined,
      verify: () => verify(),
      restart,
      close,
      restoreConnectionArgs: [
        `--host=${socketDirectory}`,
        `--port=${port}`,
        '--username=whaleu_test',
        '--dbname=whaleu_test',
      ],
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Restore cluster startup and cleanup failed',
        { cause: cleanup },
      );
    }
    throw error;
  }
}
