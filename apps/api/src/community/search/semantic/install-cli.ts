import 'reflect-metadata';
import { Pool } from 'pg';
import { loadConfig } from '../../../config/config.js';
import { poolOptions } from '../../../database/database.js';
import { installSemanticSearch } from './install.js';

async function main(): Promise<void> {
  if (process.argv[2] !== 'install-local')
    throw new Error('Expected install-local');
  const config = loadConfig(process.env);
  if (config.NODE_ENV === 'production')
    throw new Error('Local installation only');
  const url = new URL(config.DATABASE_URL);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['/whaleu_test', '/whaleu_dev'].includes(url.pathname)
  )
    throw new Error('Local installation only');
  const pool = new Pool({ ...poolOptions(config), max: 1 });
  try {
    process.stdout.write(`${await installSemanticSearch(pool)}\n`);
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write(
    'Optional semantic installation failed; check local database, migration history and pgvector capability\n',
  );
  process.exitCode = 1;
});
