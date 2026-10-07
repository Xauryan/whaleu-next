import type { MigrationMode } from './migration.js';
export interface SchoolMigrationCommand {
  readonly mode: MigrationMode;
  readonly file: string;
  readonly allowProduction: boolean;
}
export function parseSchoolMigrationCommand(
  args: readonly string[],
): SchoolMigrationCommand {
  const pending = [...args];
  let mode: MigrationMode = 'dry-run';
  if (pending[0] === 'dry-run' || pending[0] === 'apply')
    mode = pending.shift() as MigrationMode;
  let file: string | undefined;
  let allowProduction = false;
  for (const argument of pending) {
    if (argument.startsWith('--file=') && !file) file = argument.slice(7);
    else if (argument === '--allow-production' && !allowProduction)
      allowProduction = true;
    else throw new Error('Invalid school migration arguments');
  }
  if (!file || file.trim() !== file)
    throw new Error('School migration requires --file=reviewed-manifest.json');
  return { mode, file, allowProduction };
}
export function assertSchoolMigrationPermission(
  command: SchoolMigrationCommand,
  environment: string,
): void {
  if (
    environment === 'production' &&
    command.mode === 'apply' &&
    !command.allowProduction
  ) {
    throw new Error(
      'Production school migration requires separately authorized explicit operator opt-in',
    );
  }
}
