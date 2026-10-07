import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readMigrations, verifyHistory } from '../src/database/migrations.js';

test('migration discovery uses stable ordered filenames and checksums', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whaleu-migrations-'));
  try {
    await writeFile(join(dir, '0002_second.sql'), 'SELECT 2;\n');
    await writeFile(join(dir, '0001_first.sql'), 'SELECT 1;\n');
    const migrations = await readMigrations(dir);
    assert.deepEqual(
      migrations.map(({ name }) => name),
      ['0001_first.sql', '0002_second.sql'],
    );
    assert.equal(migrations[0]?.checksum.length, 64);
    verifyHistory(migrations, [migrations[0]!]);
    assert.throws(
      () =>
        verifyHistory(migrations, [{ name: 'missing.sql', checksum: 'bad' }]),
      /mismatch/,
    );
    assert.throws(
      () => verifyHistory(migrations, [{ ...migrations[0]!, checksum: 'bad' }]),
      /mismatch/,
    );
    assert.throws(
      () => verifyHistory(migrations, [migrations[1]!]),
      /ordered prefix/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('migration discovery rejects duplicate numbers, invalid files, empty SQL, and symlinks', async () => {
  for (const mode of ['duplicate', 'invalid', 'empty', 'symlink']) {
    const dir = await mkdtemp(join(tmpdir(), 'whaleu-migrations-'));
    try {
      await writeFile(join(dir, '0001_first.sql'), 'SELECT 1;');
      if (mode === 'duplicate')
        await writeFile(join(dir, '0001_duplicate.sql'), 'SELECT 2;');
      if (mode === 'invalid')
        await writeFile(join(dir, 'bad.sql'), 'SELECT 2;');
      if (mode === 'empty') await writeFile(join(dir, '0002_empty.sql'), ' \n');
      if (mode === 'symlink')
        await symlink(join(dir, '0001_first.sql'), join(dir, '0002_link.sql'));
      await assert.rejects(readMigrations(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
