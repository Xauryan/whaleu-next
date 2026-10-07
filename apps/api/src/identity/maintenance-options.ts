import { maintenanceOptions } from './maintenance.js';
import type { MaintenanceOptions } from './maintenance.js';

export interface MaintenanceCommand extends MaintenanceOptions {
  readonly batches: number;
  readonly allowProduction: boolean;
}
export function parseMaintenanceCommand(
  args: readonly string[],
): MaintenanceCommand {
  const pending = [...args];
  let mode: MaintenanceOptions['mode'] = 'dry-run';
  if (pending[0] === 'dry-run' || pending[0] === 'apply')
    mode = pending.shift() as MaintenanceOptions['mode'];
  const flags = new Map<string, string>();
  let allowProduction = false;
  for (const flag of pending) {
    if (flag === '--allow-production' && !allowProduction) {
      allowProduction = true;
      continue;
    }
    const match = /^--(retention-days|batch-size|batches)=(\d+)$/.exec(flag);
    if (!match || flags.has(match[1]!))
      throw new Error('Invalid authentication maintenance arguments');
    flags.set(match[1]!, match[2]!);
  }
  const options = maintenanceOptions({
    mode,
    ...(flags.has('retention-days')
      ? { retentionDays: Number(flags.get('retention-days')) }
      : {}),
    ...(flags.has('batch-size')
      ? { batchSize: Number(flags.get('batch-size')) }
      : {}),
  });
  const batches = Number(flags.get('batches') ?? 1);
  if (
    !Number.isInteger(batches) ||
    batches < 1 ||
    batches > 100 ||
    (mode === 'dry-run' && batches !== 1)
  )
    throw new Error('Invalid authentication maintenance batch count');
  return { ...options, batches, allowProduction };
}

export function assertMaintenancePermission(
  command: MaintenanceCommand,
  environment: string,
): void {
  if (
    environment === 'production' &&
    command.mode === 'apply' &&
    !command.allowProduction
  )
    throw new Error(
      'Production authentication maintenance requires explicit operator opt-in',
    );
}
