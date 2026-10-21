import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assertReviewedNativeHarnessSuccessor,
  verifyReviewedNativeHarnessSuccessor,
  type NativeHarnessEvidence,
} from './reviewed-native-harness-successor';
const read = (file: string) => readFileSync(path.join(__dirname, '..', file));
const original =
  'f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05';
const file = 'test/native-press-emitted-harness.mjs';
const evidence = (): NativeHarnessEvidence => ({
  manifest: read('test/fixtures/native-harness-successor-v38.json'),
  original: read('test/fixtures/native-harness-original-f271.mjs.txt'),
  current: read(file),
  parser: read('scripts/smoke-ratings.mjs'),
  parserOriginal: read(
    'test/fixtures/native-renderer-original-7cc376ea.mjs.txt',
  ),
  parserSuccessorManifest: read(
    'test/fixtures/native-renderer-attribute-successor-v38h6.json',
  ),
  originalApproval: read(
    'test/fixtures/framework7-activities-reviewed-shared.json',
  ),
});
test('reviewed native harness successor requires exact path, baseline, original bytes and audited lineage', () => {
  assert.equal(assertReviewedNativeHarnessSuccessor(file, original), true);
  assert.equal(
    assertReviewedNativeHarnessSuccessor(`apps/wechat/${file}`, original),
    true,
  );
  for (const unknown of [
    'src/components/f7-button/f7-button.ts',
    'src/auth/session.ts',
    'test/text-review-emitted-harness.mjs',
    '../test/native-press-emitted-harness.mjs',
    file + '.bak',
  ]) {
    assert.equal(
      assertReviewedNativeHarnessSuccessor(unknown, original),
      false,
    );
  }
  for (const unknown of [
    'unrelated',
    '085e3f616ded754cb13694157e9598efe1de296c92d2b4e56748bcfb0c727d98',
    '306d35b89f579272c6fdd9858ae91d692ca6505f0acbec771255097c0b19b83b',
  ]) {
    assert.equal(assertReviewedNativeHarnessSuccessor(file, unknown), false);
  }
});
test('reviewed native harness allowance rejects mutated original, current bridge, parser and predecessor approval', () => {
  for (const key of [
    'original',
    'current',
    'parser',
    'parserOriginal',
    'parserSuccessorManifest',
    'originalApproval',
  ] as const) {
    const changed = evidence();
    changed[key] = Buffer.concat([
      changed[key],
      Buffer.from('\n// unreviewed mutation'),
    ]);
    assert.throws(
      () => verifyReviewedNativeHarnessSuccessor(file, original, changed),
      assert.AssertionError,
      key,
    );
  }
});
test('reviewed native harness allowance rejects stale or forged provenance even with valid source bytes', () => {
  for (const mutate of [
    (manifest: Record<string, unknown>) => {
      manifest.afterSha256 = original;
    },
    (manifest: Record<string, unknown>) => {
      manifest.file = 'src/auth/session.ts';
    },
    (manifest: Record<string, unknown>) => {
      manifest.lineage = [];
    },
    (manifest: Record<string, unknown>) => {
      manifest.review = 'forged approval';
    },
  ]) {
    const changed = evidence();
    const manifest = JSON.parse(changed.manifest.toString()) as Record<
      string,
      unknown
    >;
    mutate(manifest);
    changed.manifest = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    assert.throws(
      () => verifyReviewedNativeHarnessSuccessor(file, original, changed),
      /provenance and lineage/,
    );
  }
});

test('attribute decoder successor rejects stale parser bytes and forged replacement lineage', () => {
  const stale = evidence();
  stale.parser = stale.parserOriginal;
  assert.throws(
    () => verifyReviewedNativeHarnessSuccessor(file, original, stale),
    /exact reviewed single-pass attribute decoder successor/,
  );
  for (const mutate of [
    (manifest: Record<string, unknown>) => {
      manifest.beforeSha256 = 'unreviewed predecessor';
    },
    (manifest: Record<string, unknown>) => {
      manifest.afterSha256 = manifest.beforeSha256;
    },
    (manifest: Record<string, unknown>) => {
      manifest.file = 'src/pages/directory-detail/directory-detail.wxml';
    },
    (manifest: Record<string, unknown>) => {
      manifest.historicalHarnessApprovalSha256 = 'forged historical approval';
    },
    (manifest: Record<string, unknown>) => {
      manifest.review = 'forged decoder approval';
    },
  ]) {
    const changed = evidence();
    const manifest = JSON.parse(
      changed.parserSuccessorManifest.toString(),
    ) as Record<string, unknown>;
    mutate(manifest);
    changed.parserSuccessorManifest = Buffer.from(
      JSON.stringify(manifest, null, 2) + '\n',
    );
    assert.throws(
      () => verifyReviewedNativeHarnessSuccessor(file, original, changed),
      /reviewed attribute decoder provenance/,
    );
  }
});
