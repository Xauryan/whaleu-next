import 'reflect-metadata';
import { Pool } from 'pg';
import { loadConfig } from '../config/config.js';
import { inTransaction, poolOptions } from '../database/database.js';
import {
  parseSessionEpochStatusCommand,
  sessionEpochStatus,
} from './session-epoch-status.js';
async function main() {
  parseSessionEpochStatusCommand(process.argv.slice(2));
  const config = loadConfig(process.env);
  const pool = new Pool({ ...poolOptions(config), max: 1 });
  pool.on('error', () =>
    process.stderr.write('Session epoch database connection failed\n'),
  );
  try {
    const status = await inTransaction(pool, sessionEpochStatus, {
      isolationLevel: 'read committed',
    });
    // Protocol state only; no account IDs, subjects, fingerprints, role credentials or URL.
    process.stdout.write(JSON.stringify(status) + '\n');
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write(
    'Session epoch status unavailable; check the fixed schema, command and database configuration\n',
  );
  process.exitCode = 1;
});
