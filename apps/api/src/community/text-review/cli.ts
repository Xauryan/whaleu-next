import 'reflect-metadata';
import { hostname, userInfo } from 'node:os';
import { Pool } from 'pg';
import { loadConfig } from '../../config/config.js';
import { inTransaction, poolOptions } from '../../database/database.js';
import { ApprovalRepository } from '../content-review/approval.repository.js';
import { TextReviewRuntime } from './runtime.js';
import { reviewOperatorCommandSchema, TextReviewOperator } from './operator.js';

async function main(): Promise<void> {
  // One JSON command only. No automatic decisions, batch allow, or network issuer.
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('One explicit command is required');
  const command = reviewOperatorCommandSchema.parse(JSON.parse(args[0]!));
  if (command.command === 'show' && !process.stdout.isTTY)
    throw new Error('Content display requires a private interactive terminal');
  const config = loadConfig(process.env);
  const operator = `local:${hostname()}:${userInfo().username}`;
  const service = new TextReviewOperator(
    new TextReviewRuntime(config, new ApprovalRepository()),
    operator,
  );
  const pool = new Pool({ ...poolOptions(config), max: 1 });
  pool.on('error', () =>
    process.stderr.write('Local review database connection failed\n'),
  );
  try {
    const result = await inTransaction(pool, (tx) => service.run(command, tx));
    // JSON escapes control characters. Only explicit show includes private content;
    // no logger receives a body, and all ordinary commands return metadata only.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write(
    'Local review failed; check command, operator, non-production configuration and pending request\n',
  );
  process.exitCode = 1;
});
