import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('only exhaustive API static typecheck receives the explicit 3 GiB compiler heap', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts['typecheck'],
    'node --max-old-space-size=3072 ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit',
  );
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert.doesNotMatch(command, /NODE_OPTIONS/);
    if (name !== 'typecheck')
      assert.doesNotMatch(command, /max-old-space-size/);
  }
  const config = JSON.parse(
    readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'),
  ) as { include: string[]; exclude?: unknown };
  assert.deepEqual(config.include, [
    'src/**/*.ts',
    'test/**/*.ts',
    'scripts/**/*.ts',
  ]);
  assert.equal(config.exclude, undefined);
});
