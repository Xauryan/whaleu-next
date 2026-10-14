import { readFile } from 'node:fs/promises';
import { validateSchoolUidInventory } from './inventory.js';

// Offline and read-only by design. Real apply is deliberately not a CLI option.
async function main() {
  const [command, filename, ...rest] = process.argv.slice(2);
  if (command !== 'validate' || !filename || rest.length) {
    process.stderr.write(
      'Usage: node --import tsx src/school-uid/inventory-cli.ts validate <manifest.json>\n',
    );
    process.exitCode = 2;
    return;
  }
  const report = validateSchoolUidInventory(
    JSON.parse(await readFile(filename, 'utf8')),
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.quarantinedSchools.length) process.exitCode = 1;
}
main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.message : 'Inventory validation failed') +
      '\n',
  );
  process.exitCode = 2;
});
