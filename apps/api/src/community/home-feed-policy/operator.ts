import 'reflect-metadata';
import { hostname, userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { loadConfig } from '../../config/config.js';
import { inTransaction, poolOptions } from '../../database/database.js';
import { homeAdmissionCommandSchema } from './admission-contract.js';
import { configureHomeAdmission } from './admission.js';

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('One explicit JSON command required');
  const command = homeAdmissionCommandSchema.parse(JSON.parse(args[0]!));
  const config = loadConfig(process.env);
  // Same source_manual CLI identity convention as text-review/cli.ts.
  const operator = `manual:${hostname()}:${userInfo().username}`;
  if (
    config.COMMUNITY_TEXT_REVIEW !== 'source_manual' ||
    config.COMMUNITY_TEXT_REVIEW_OPERATOR !== operator
  )
    throw new Error('Configured source-manual operator required');
  const pool = new Pool({ ...poolOptions(config), max: 1 });
  pool.on('error', () =>
    process.stderr.write('Home policy database connection failed\n'),
  );
  try {
    const result = await inTransaction(pool, (tx) =>
      configureHomeAdmission(command, config, operator, tx),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write(
      'Home policy operation failed; check explicit configuration, preparation and current admission\n',
    );
    process.exitCode = 1;
  });
}
