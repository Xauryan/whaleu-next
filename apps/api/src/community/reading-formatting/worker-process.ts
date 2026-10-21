import {
  readingTablePrivileges,
  readingColumnPrivileges,
} from './role-contract.js';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../config/config.js';
import type { ReadingFormattingWorker } from './worker.js';

export interface ReadingProcessOptions {
  readonly mode: 'once' | 'serve';
  readonly ticks: number;
  readonly intervalMs: number;
}
export function readingProcessOptions(
  config: RuntimeConfig,
  args: readonly string[],
): ReadingProcessOptions {
  if (config.COMMUNITY_READING_FORMATTING_PROCESSING === 'disabled')
    throw new Error('Reading processing is disabled');
  if (args.length !== 1 || !['once', 'serve'].includes(args[0]!))
    throw new Error('Expected explicit once or serve');
  if (
    args[0] === 'serve' &&
    config.COMMUNITY_READING_FORMATTING_PROCESSING !== 'automatic'
  )
    throw new Error('Serve requires explicit automatic configuration');
  return Object.freeze({
    mode: args[0] === 'serve' ? 'serve' : 'once',
    ticks: config.COMMUNITY_READING_FORMATTING_TICKS_PER_CYCLE,
    intervalMs: config.COMMUNITY_READING_FORMATTING_INTERVAL_MS,
  });
}
/** Enforced production role floor. No grants or credentials are created here.
 * Credential custody still must exclude arbitrary SQL clients and other writers. */
export async function assertReadingWorkerRole(tx: PoolClient): Promise<void> {
  const value = (
    await tx.query<{ admitted: boolean }>(
      `WITH owned AS (
    SELECT c.oid,c.relowner,n.nspname||'.'||c.relname relation FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE starts_with(n.nspname,'whaleu_') AND c.relkind IN('r','p','v','m','f')
  ), allowed AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS a(relation text,privilege text)),
  columns_allowed AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS a(relation text,"column" text,privilege text)),
  forbidden AS (
    SELECT o.oid,p.privilege FROM owned o CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('TRIGGER'),('REFERENCES'),('MAINTAIN')) p(privilege)
    WHERE NOT EXISTS(SELECT 1 FROM allowed a WHERE a.relation=o.relation AND a.privilege=p.privilege)
  ) SELECT NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
    AND current_setting('session_replication_role')='origin'
    AND NOT has_parameter_privilege(current_user,'session_replication_role','SET')
    AND NOT has_database_privilege(current_user,current_database(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM owned o WHERE pg_has_role(current_user,o.relowner,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE starts_with(n.nspname,'whaleu_') AND (pg_has_role(current_user,p.proowner,'MEMBER') OR (p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE'))))
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE starts_with(n.nspname,'whaleu_') AND (has_schema_privilege(current_user,n.oid,'CREATE') OR pg_has_role(current_user,n.nspowner,'MEMBER')))
    AND NOT EXISTS(SELECT 1 FROM allowed a WHERE NOT has_table_privilege(current_user,a.relation,a.privilege))
    AND NOT EXISTS(SELECT 1 FROM columns_allowed a WHERE NOT has_column_privilege(current_user,a.relation,a."column",a.privilege))
    AND NOT EXISTS(SELECT 1 FROM forbidden f WHERE has_table_privilege(current_user,f.oid,f.privilege))
    AND NOT EXISTS(SELECT 1 FROM owned o JOIN pg_attribute c ON c.attrelid=o.oid AND c.attnum>0 AND NOT c.attisdropped CROSS JOIN (VALUES('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
      WHERE has_column_privilege(current_user,o.oid,c.attnum,p.privilege)
      AND NOT EXISTS(SELECT 1 FROM allowed a WHERE a.relation=o.relation AND a.privilege=p.privilege)
      AND NOT EXISTS(SELECT 1 FROM columns_allowed a WHERE a.relation=o.relation AND a."column"=c.attname AND a.privilege=p.privilege)) admitted
    FROM pg_roles r WHERE r.rolname=current_user`,
      [
        JSON.stringify(readingTablePrivileges),
        JSON.stringify(readingColumnPrivileges),
      ],
    )
  ).rows[0];
  if (value?.admitted !== true)
    throw new Error(
      'Reading worker requires a separately provisioned least-privilege managed-runtime role',
    );
}
export interface ReadingProcessHealth {
  readonly state:
    'starting' | 'running' | 'sleeping' | 'stopping' | 'stopped' | 'failed';
  readonly cycles: number;
  readonly ticks: number;
}
interface ProcessDependencies {
  readonly worker: Pick<ReadingFormattingWorker, 'tick'>;
  readonly ready: () => Promise<void>;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly report?: (health: ReadingProcessHealth) => void;
}
async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve();
    };
    const timer = setTimeout(stop, milliseconds);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}
/** No overlapping ticks; abort prevents the next tick and drains the current
 * managed transaction before the CLI closes its application/DB pool. */
export async function runReadingProcess(
  options: ReadingProcessOptions,
  dependencies: ProcessDependencies,
  signal: AbortSignal,
): Promise<ReadingProcessHealth> {
  if (
    !['once', 'serve'].includes(options.mode) ||
    !Number.isInteger(options.ticks) ||
    options.ticks < 1 ||
    options.ticks > 32 ||
    !Number.isInteger(options.intervalMs) ||
    options.intervalMs < 1000 ||
    options.intervalMs > 60000
  )
    throw new TypeError('Invalid bounded reading process options');
  let cycles = 0,
    ticks = 0;
  const report = (state: ReadingProcessHealth['state']) => {
    const health = Object.freeze({ state, cycles, ticks });
    dependencies.report?.(health);
    return health;
  };
  report('starting');
  try {
    if (!signal.aborted) await dependencies.ready();
    while (!signal.aborted) {
      report('running');
      for (let i = 0; i < options.ticks && !signal.aborted; i++) {
        // Recheck protocol and role for every tick, not merely process startup.
        await dependencies.ready();
        if (signal.aborted) break;
        const result = await dependencies.worker.tick();
        ticks++;
        if (result.wrapped) break;
      }
      cycles++;
      if (options.mode === 'once' || signal.aborted) break;
      report('sleeping');
      await (dependencies.wait ?? sleep)(options.intervalMs, signal);
    }
    report('stopping');
    return report('stopped');
  } catch (error) {
    report('failed');
    throw error;
  }
}
