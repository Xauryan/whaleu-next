import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { loadConfig } from '../config/config.js';
import { poolOptions } from './database.js';
import { readMigrations, runMigrations } from './migrations.js';

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'up' && mode !== 'status')
    throw new Error('Expected migration command: up or status');
  const config = loadConfig(process.env);
  const migrations = await readMigrations(
    fileURLToPath(new URL('../../migrations/', import.meta.url)),
  );
  const pool = new Pool({ ...poolOptions(config), max: 1 });
  pool.on('error', () =>
    process.stderr.write('Migration database connection failed\n'),
  );
  try {
    const state = await runMigrations(pool, migrations, { mode });
    process.stdout.write(
      `${JSON.stringify({ command: mode, migrations: state })}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write(
    'Migration failed; check configuration, database availability, and migration history\n',
  );
  process.exitCode = 1;
});
