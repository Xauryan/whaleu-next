import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// These hashes identify the signed ff2f predecessor, not generated current code.
const originals = {
  service: 'a9f2780384c400b956a74fa4877191c354fbe0060456de0e6bead7097634207b',
  proof: 'e9346b25d54be406eacbc9b5de5af72c3f3877df2adf2fb33840480edba0626e',
};
for (const [name, expected] of Object.entries(originals)) {
  test(`Historical avatar ${name} is the signed owner with import relocation only`, async () => {
    const snapshot = fileURLToPath(
      new URL(
        `./support/historical-avatar-moderation/${name}.ts`,
        import.meta.url,
      ),
    );
    const original = fileURLToPath(
      new URL(`../src/profile/avatar-moderation/${name}.ts`, import.meta.url),
    );
    const bytes = await readFile(snapshot, 'utf8');
    const restored = bytes.replace(
      /from '([^']+)'/g,
      (whole, specifier: string) => {
        if (
          !specifier.startsWith('.') ||
          (name === 'service' && specifier === './proof.js')
        )
          return whole;
        const target = path.resolve(path.dirname(snapshot), specifier);
        const relative = path
          .relative(path.dirname(original), target)
          .split(path.sep)
          .join('/');
        return `from '${relative.startsWith('.') ? relative : './' + relative}'`;
      },
    );
    assert.equal(createHash('sha256').update(restored).digest('hex'), expected);
  });
}
