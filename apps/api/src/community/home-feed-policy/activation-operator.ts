import 'reflect-metadata';
import { hostname, userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { loadConfig } from '../../config/config.js';
import { inTransaction, poolOptions } from '../../database/database.js';
import {
  configureHomePublication,
  homeActivationCommandSchema,
} from './activation.js';
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('One explicit JSON command required');
  const command = homeActivationCommandSchema.parse(JSON.parse(args[0]!));
  const config = loadConfig(process.env),
    operator = `manual:${hostname()}:${userInfo().username}`;
  if (
    config.COMMUNITY_TEXT_REVIEW !== 'source_manual' ||
    config.COMMUNITY_TEXT_REVIEW_OPERATOR !== operator
  )
    throw new Error(
      'Source-manual OS reviewer configuration required; explicit-review activation is not supported',
    );
  const pool = new Pool({ ...poolOptions(config), max: 1 });
  pool.on('error', () =>
    process.stderr.write('Home activation database connection failed\n'),
  );
  try {
    const result = await inTransaction(pool, (tx) =>
      configureHomePublication(command, config, operator, tx),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write(
      'Home activation failed; check source-manual identity, formal schema, current policy and preparation\n',
    );
    process.exitCode = 1;
  });
