import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { DatabaseService } from '../database/database.js';
import { CampusToolsAdmission } from './admission.js';
import type { CampusToolsRuntime } from './runtime.js';
import { validateToolManifest } from './validation.js';
export interface ToolsCliDependencies {
  readonly database: DatabaseService;
  readonly runtime: CampusToolsRuntime;
}
/** Injectable operational entrypoint: the synthetic harness supplies its isolated
 * DB+trusted authority. The standalone production runner has no authority and
 * cannot obtain one from a manifest field, role, import path or environment flag. */
export async function runCampusToolsCli(
  args: readonly string[],
  dependencies: ToolsCliDependencies | null = null,
) {
  const [command, path, key, ...extra] = args;
  if (
    extra.length ||
    !path ||
    !['validate', 'apply'].includes(command ?? '') ||
    (command === 'validate' && key !== undefined) ||
    (command === 'apply' && !key)
  )
    throw new Error(
      'Usage: campus-tools validate <canonical-manifest> | apply <canonical-manifest> <request-uuid>',
    );
  const file = await open(path, 'r');
  let source: string;
  try {
    const buffer = Buffer.alloc(262146);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > 262144) throw new Error('MANIFEST_TOO_LARGE');
    source = new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    await file.close();
  }
  if (command === 'validate') {
    try {
      return validateToolManifest(source).report;
    } catch {
      return {
        state: 'quarantined' as const,
        trusted: false as const,
        reasons: ['INVALID_OR_NONCANONICAL_MANIFEST'],
      };
    }
  }
  validateToolManifest(source);
  if (!dependencies)
    throw new Error('CAMPUS_TOOLS_TRUSTED_ADAPTER_UNCONFIGURED');
  return new CampusToolsAdmission(
    dependencies.database,
    dependencies.runtime,
  ).apply(source, key!);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCampusToolsCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => {
      process.stderr.write(
        'Campus tools validation/application failed; no source payload is echoed.\n',
      );
      process.exitCode = 1;
    },
  );
}
