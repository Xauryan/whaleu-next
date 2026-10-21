import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runtimeIdentityEvidenceRoot,
  runtimeIdentityPaths,
  runtimeIdentityPredecessor,
  runtimeIdentityProofPaths,
  runtimeIdentitySuccessors,
} from './reviewed-reading-runtime-identity-successor';
import {
  assertReviewedReadingSuccessor,
  readingSuccessors,
} from './reviewed-reading-successor';
const read = (file: string) => readFileSync(path.join(__dirname, '..', file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const before = (entry: (typeof runtimeIdentitySuccessors)[number]) =>
  read(`${runtimeIdentityEvidenceRoot}/${entry.evidence}`);

test('six exact b531 owners reverse independently; only explicit aliases compose', () => {
  for (const entry of runtimeIdentitySuccessors) {
    for (const alias of [entry.path, `apps/wechat/${entry.path}`]) {
      assert.deepEqual(
        runtimeIdentityPredecessor(alias, read(entry.path)),
        before(entry),
      );
      assert.equal(sha(before(entry)), entry.before);
    }
    assert.throws(() => runtimeIdentityPredecessor(entry.path, before(entry)));
    assert.throws(() =>
      runtimeIdentityPredecessor(
        entry.path,
        Buffer.concat([read(entry.path), Buffer.from('\n')]),
      ),
    );
  }
  for (const unknown of [
    'src/api/other.ts',
    './src/api/client.ts',
    'src/../src/api/client.ts',
    'src/api/client.ts.bak',
    'SRC/API/CLIENT.TS',
    'constructor',
    '__proto__',
  ]) {
    const bytes = Buffer.from('unreviewed');
    assert.equal(
      runtimeIdentityPredecessor(unknown, bytes, () => {
        throw new Error('unknown paths must not read proof');
      }),
      bytes,
    );
  }
});

test('all evidence, original seal and every owner are required even when requesting another file', () => {
  const first = runtimeIdentitySuccessors[0]!;
  const reading = readingSuccessors[0]!;
  for (const target of [
    ...runtimeIdentityProofPaths,
    ...runtimeIdentityPaths,
    'test/fixtures/reviewed-reading-successor/manifest.json',
  ]) {
    const corrupt = (file: string) =>
      file === target
        ? Buffer.concat([read(file), Buffer.from('\n')])
        : read(file);
    assert.throws(
      () => runtimeIdentityPredecessor(first.path, read(first.path), corrupt),
      target,
    );
    assert.throws(
      () =>
        assertReviewedReadingSuccessor(reading.path, reading.before, corrupt),
      target,
    );
  }
  // No partial rollback or stale cross-file snapshot can use the new admission.
  for (const stale of runtimeIdentitySuccessors) {
    const mixed = (file: string) =>
      file === stale.path ? before(stale) : read(file);
    assert.throws(
      () => runtimeIdentityPredecessor(first.path, read(first.path), mixed),
      stale.path,
    );
    assert.throws(
      () => assertReviewedReadingSuccessor(reading.path, reading.before, mixed),
      stale.path,
    );
  }
  const allOld = (file: string) => {
    const entry = runtimeIdentitySuccessors.find(
      (source) => source.path === file,
    );
    return entry ? before(entry) : read(file);
  };
  assert.throws(() =>
    runtimeIdentityPredecessor(first.path, before(first), allOld),
  );
});

test('sealed six-file unified patch applies and reverses to exact full-file bytes', () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'reading-identity-proof-'),
  );
  try {
    for (const entry of runtimeIdentitySuccessors) {
      const target = path.join(directory, 'apps/wechat', entry.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, before(entry));
    }
    const patch = read(`${runtimeIdentityEvidenceRoot}/correction.patch`);
    const targets = patch
      .toString('utf8')
      .split('\n')
      .filter((line) => line.startsWith('diff --git '))
      .map((line) => line.split(' b/apps/wechat/')[1]);
    assert.deepEqual(
      targets,
      runtimeIdentityPaths,
      'patch has exactly the six reviewed owners',
    );
    execFileSync('git', ['apply', '--check', '-'], {
      cwd: directory,
      input: patch,
    });
    execFileSync('git', ['apply', '-'], { cwd: directory, input: patch });
    for (const entry of runtimeIdentitySuccessors)
      assert.deepEqual(
        readFileSync(path.join(directory, 'apps/wechat', entry.path)),
        read(entry.path),
      );
    execFileSync('git', ['apply', '--reverse', '--check', '-'], {
      cwd: directory,
      input: patch,
    });
    execFileSync('git', ['apply', '--reverse', '-'], {
      cwd: directory,
      input: patch,
    });
    for (const entry of runtimeIdentitySuccessors)
      assert.deepEqual(
        readFileSync(path.join(directory, 'apps/wechat', entry.path)),
        before(entry),
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('private-chat API boundary retains its exact old hash and unknown boundaries remain live', () => {
  const protectedFiles = JSON.parse(
    read(
      'test/fixtures/framework7-private-chat-before-protected.json',
    ).toString('utf8'),
  ) as Record<string, string>;
  const file = 'src/api/client.ts';
  const expected = protectedFiles[file];
  assert.equal(
    expected,
    'c7f340534bde17711894e950cbeab36a2aed54091127b50af4d2867e9d7f80af',
  );
  assert.equal(sha(runtimeIdentityPredecessor(file, read(file))), expected);
  for (const target of runtimeIdentityPaths) {
    const corrupt = (name: string) =>
      name === target
        ? Buffer.concat([read(name), Buffer.from('\n')])
        : read(name);
    assert.throws(
      () => runtimeIdentityPredecessor(file, corrupt(file), corrupt),
      target,
    );
  }
  const other = Object.keys(protectedFiles).find(
    (name) => !runtimeIdentityPaths.includes(name),
  )!;
  assert.ok(other);
  const changed = Buffer.concat([read(other), Buffer.from('\n')]);
  const unchanged = runtimeIdentityPredecessor(other, changed, () => {
    throw new Error('an unrelated protected boundary must remain live');
  });
  assert.equal(unchanged, changed);
  assert.notEqual(sha(unchanged), protectedFiles[other]);
});
