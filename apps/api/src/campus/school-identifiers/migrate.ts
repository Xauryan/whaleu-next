import 'reflect-metadata';
import { readFile, stat } from 'node:fs/promises';
import { Pool } from 'pg';
import { loadConfig } from '../../config/config.js';
import { poolOptions } from '../../database/database.js';
import { schoolIdentifierManifestSchema } from './contracts.js';
import { migrateSchoolIdentifiers } from './migration.js';
import {
  assertSchoolMigrationPermission,
  parseSchoolMigrationCommand,
} from './options.js';

async function main(): Promise<void> {
  const command = parseSchoolMigrationCommand(process.argv.slice(2));
  const config = loadConfig(process.env);
  assertSchoolMigrationPermission(command, config.NODE_ENV);
  const file = await stat(command.file);
  if (!file.isFile() || file.size > 10 * 1024 * 1024)
    throw new Error('Manifest must be a JSON file up to 10 MiB');
  const manifest = schoolIdentifierManifestSchema.parse(
    JSON.parse(await readFile(command.file, 'utf8')),
  );
  const pool = new Pool({ ...poolOptions(config), max: 1 });
  pool.on('error', () =>
    process.stderr.write('School identifier database connection failed\n'),
  );
  try {
    const result = await migrateSchoolIdentifiers(pool, manifest, command.mode);
    // Local operator report contains explicit source IDs, never database credentials.
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ready) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write(
    'School identifier migration failed; verify the reviewed manifest, arguments, configuration and existing schema. Inspect the registry before retrying an uncertain outcome.\n',
  );
  process.exitCode = 1;
});
