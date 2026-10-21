/** Disposable TLS LOGIN fixture. Password authentication is asserted only in the
 * explicit password lane; local trust never counts as password evidence.
 * Original exact grants and managed-runtime contract are reused unchanged. */
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { ReadingWorkerDockerTarget } from './reading-worker-docker-target.js';
import { createReadingWorkerRole } from './reading-worker-role.js';

export function readingLoginAuthMode(value: unknown): 'trust' | 'password' {
  if (value !== 'trust' && value !== 'password')
    throw new Error(
      'TEST_READING_LOGIN_AUTH must explicitly be trust or password',
    );
  return value;
}
/** ASCII-only random fixture password avoids SASLprep ambiguity. Cleartext never
 * enters SQL. This SCRAM verifier exists only during the disposable role's life. */
export function readingWorkerScramVerifier(
  password: string,
  salt: Buffer,
): string {
  assert.ok(
    /^[a-f0-9]{64}$/.test(password),
    'Invalid synthetic password shape',
  );
  assert.equal(salt.length, 16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', salted)
    .update('Server Key')
    .digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
export function readingWorkerLoginUrl(
  database: string,
  name: string,
  password = '',
): string {
  const url = new URL(database);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.match(name, /^reading_test_[a-f0-9]{32}$/);
  url.username = name;
  assert.ok(
    password === '' || /^[a-f0-9]{64}$/.test(password),
    'Invalid synthetic password shape',
  );
  url.password = password;
  return url.href;
}
export async function createReadingWorkerLogin(
  pool: Pool,
  database: string,
  docker?: ReadingWorkerDockerTarget,
) {
  // Validate before any role mutation; the original helper separately checks
  // actual current_database() and the canonical server address.
  readingWorkerLoginUrl(database, 'reading_test_' + '0'.repeat(32));
  const tls = await pool.query<{ ssl: boolean }>(
    'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
  );
  assert.equal(tls.rows[0]?.ssl, true);
  const role = await createReadingWorkerRole(pool, docker);
  try {
    const password = randomBytes(32).toString('hex');
    const verifier = readingWorkerScramVerifier(password, randomBytes(16));
    // Generated verifier alphabet contains no SQL quote/backslash. Never send
    // cleartext password as SQL, statement parameter, diagnostic or fixture file.
    assert.ok(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(
        verifier,
      ),
    );
    await pool.query(`ALTER ROLE "${role.name}" LOGIN PASSWORD '${verifier}'`);
    return {
      ...role,
      database: readingWorkerLoginUrl(database, role.name, password),
    };
  } catch {
    // No error object, URL, credential or query text is included in diagnostics.
    try {
      await role.close();
    } catch {
      throw new AggregateError(
        [new Error('LOGIN setup failed'), new Error('Role cleanup failed')],
        'Disposable reading LOGIN setup and cleanup failed',
      );
    }
    throw new Error('Disposable reading LOGIN setup failed');
  }
}
