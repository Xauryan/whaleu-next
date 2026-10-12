import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  artifactContext,
  createArtifact,
  inventory,
  restoreArtifact,
  verifyArtifact,
} from './ci-native-artifact.mjs';

const context = {
  version: 1,
  sha: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  runId: '123',
  runAttempt: '1',
  platform: 'linux',
  arch: 'x64',
  node: 'v24.19.0',
  npm: '11.9.0',
  lockSha256: 'c'.repeat(64),
};
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'whaleu-native-artifact-'));
  const source = join(root, 'source');
  const artifact = join(root, 'artifact');
  mkdirSync(source);
  writeFileSync(join(source, 'app.js'), 'App({});');
  writeFileSync(join(source, 'app.json'), '{}');
  try {
    run({ root, source, artifact });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('only checked native bytes are staged, verified and restored once', () =>
  fixture(({ root, source, artifact }) => {
    const manifest = createArtifact(source, artifact, context);
    assert.equal(manifest.files.length, 2);
    assert.deepEqual(verifyArtifact(artifact, context), manifest);
    const destination = join(root, 'restored');
    restoreArtifact(artifact, destination, context);
    assert.equal(readFileSync(join(destination, 'app.js'), 'utf8'), 'App({});');
    assert.deepEqual(inventory(destination), inventory(source));
    assert.throws(
      () => restoreArtifact(artifact, destination, context),
      /fresh/,
    );
    assert.throws(() => createArtifact(source, artifact, context), /fresh/);
  }));

test('source SHA, tree, run, producer attempt, lockfile and toolchain must all match', () =>
  fixture(({ source, artifact }) => {
    createArtifact(source, artifact, context);
    for (const key of Object.keys(context))
      assert.throws(
        () =>
          verifyArtifact(artifact, {
            ...context,
            [key]: `${context[key]}-different`,
          }),
        /provenance/,
      );
    assert.throws(
      () => verifyArtifact(artifact, { ...context, unexpected: true }),
      /provenance/,
    );
  }));

test('modified, added and missing artifact bytes fail before restoring', () => {
  for (const change of [
    (dist) => writeFileSync(join(dist, 'app.js'), 'changed'),
    (dist) => writeFileSync(join(dist, 'extra.js'), 'unexpected'),
    (dist) => rmSync(join(dist, 'app.json')),
  ])
    fixture(({ root, source, artifact }) => {
      createArtifact(source, artifact, context);
      change(join(artifact, 'dist'));
      assert.throws(() =>
        restoreArtifact(artifact, join(root, 'destination'), context),
      );
    });
});

test('hidden files, credentials, foreign outputs, symlinks and malformed envelopes are rejected', () => {
  for (const name of ['.env', '.npmrc', 'credential.pem', 'application.zip'])
    fixture(({ source, artifact }) => {
      writeFileSync(join(source, name), 'not an output');
      assert.throws(
        () => createArtifact(source, artifact, context),
        /Unexpected/,
      );
    });
  fixture(({ root, source, artifact }) => {
    symlinkSync(join(source, 'app.js'), join(source, 'linked.js'));
    assert.throws(() => createArtifact(source, artifact, context), /symlinks/);
    rmSync(join(source, 'linked.js'));
    createArtifact(source, artifact, context);
    writeFileSync(join(artifact, 'outside.js'), 'unexpected');
    assert.throws(() => verifyArtifact(artifact, context), /envelope/);
    rmSync(join(artifact, 'outside.js'));
    const manifest = readFileSync(join(artifact, 'manifest.json'));
    writeFileSync(join(root, 'external.json'), manifest);
    rmSync(join(artifact, 'manifest.json'));
    symlinkSync(join(root, 'external.json'), join(artifact, 'manifest.json'));
    assert.throws(() => verifyArtifact(artifact, context), /envelope/);
  });
});

test('app entrypoints are required and the sole text output is the vendor license', () =>
  fixture(({ source, artifact }) => {
    mkdirSync(join(source, 'vendor'));
    writeFileSync(join(source, 'vendor/js-sha256-LICENSE.txt'), 'MIT');
    assert.equal(createArtifact(source, artifact, context).files.length, 3);
    rmSync(join(source, 'app.js'));
    assert.throws(() => inventory(source), /entrypoints/);
  }));

test('artifact context binds the exact clean checkout and supports only the declared producer attempt', () =>
  fixture(({ root }) => {
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    const env = {
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      WHALEU_ARTIFACT_ATTEMPT: '1',
    };
    const calls = [];
    const git = (args) => {
      calls.push(args);
      return args[1] === 'HEAD'
        ? env.GITHUB_SHA
        : args[1] === 'HEAD^{tree}'
          ? 'b'.repeat(40)
          : '';
    };
    const result = artifactContext(root, env, git);
    assert.equal(result.runAttempt, '1');
    assert.equal(result.runId, '123');
    assert.equal(result.sha, env.GITHUB_SHA);
    assert.equal(result.tree, 'b'.repeat(40));
    assert.match(result.lockSha256, /^[a-f0-9]{64}$/);
    assert.ok(
      calls.some(
        (args) =>
          JSON.stringify(args) ===
          JSON.stringify(['diff', '--exit-code', 'HEAD', '--', '.']),
      ),
    );
    assert.throws(
      () =>
        artifactContext(root, env, () => {
          throw new Error('dirty source');
        }),
      /dirty source/,
    );
    for (const changes of [
      { GITHUB_SHA: 'different' },
      { GITHUB_RUN_ID: '' },
      { GITHUB_RUN_ID: '0' },
      { WHALEU_ARTIFACT_ATTEMPT: '' },
    ])
      assert.throws(
        () => artifactContext(root, { ...env, ...changes }, git),
        /provenance/,
      );
  }));
