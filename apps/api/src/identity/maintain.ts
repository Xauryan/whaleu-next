import 'reflect-metadata';
import { Pool } from 'pg';
import { loadConfig } from '../config/config.js';
import { inTransaction, poolOptions } from '../database/database.js';
import { IdentityMaintenance } from './maintenance.js';
import {
  assertMaintenancePermission,
  parseMaintenanceCommand,
} from './maintenance-options.js';

async function main(): Promise<void> {
  const command = parseMaintenanceCommand(process.argv.slice(2));
  const config = loadConfig(process.env);
  assertMaintenancePermission(command, config.NODE_ENV);
  const pool = new Pool({ ...poolOptions(config), max: 1 });
  pool.on('error', () =>
    process.stderr.write(
      'Authentication maintenance database connection failed\n',
    ),
  );
  try {
    const service = new IdentityMaintenance({
      transaction: (operation) => inTransaction(pool, operation),
    });
    for (let batch = 0; batch < command.batches; batch += 1) {
      const result = await service.run({
        mode: command.mode,
        retentionDays: command.retentionDays,
        batchSize: command.batchSize,
      });
      // Counts only, never account/session IDs, token hashes, provider IDs or database URLs.
      process.stdout.write(
        `${JSON.stringify({ command: 'auth-maintenance', batch: batch + 1, ...result })}\n`,
      );
      if (result.accessTokens + result.refreshTokens + result.sessions === 0)
        break;
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write(
    'Authentication maintenance failed; check options, explicit production opt-in, configuration and database availability\n',
  );
  process.exitCode = 1;
});
