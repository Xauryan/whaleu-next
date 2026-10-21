import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {
  canonicalSourceText,
  textSourceHash,
  textSourceIntentHash,
  type TextSourceDescriptor,
} from '../src/community/text-source-contract';

const root = path.resolve(__dirname, '..');
const contractLeaf = 'community/text-source-contract.js';
const errorsLeaf = 'api/errors.js';
const vendorLeaf = 'vendor/sha256.js';
type NativeContract = typeof import('../src/community/text-source-contract');
type NativeErrors = typeof import('../src/api/errors');

function emitLeaf(relative: string): string {
  // Two explicitly named leaves only. No program, compiler subprocess, import
  // traversal, dist output, filesystem mutation or full Mini Program build.
  assert.ok(relative === contractLeaf || relative === errorsLeaf);
  return ts.transpileModule(
    readFileSync(
      path.join(root, 'src', relative.replace(/\.js$/, '.ts')),
      'utf8',
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      },
      fileName: relative.replace(/\.js$/, '.ts'),
    },
  ).outputText;
}

async function actualBuildRewrite(compiled: string): Promise<string> {
  const buildFile = path.join(root, 'scripts/build.mjs');
  const source = readFileSync(buildFile, 'utf8');
  const beginning = 'for (const relative of [';
  const ending = "\nawait mkdir(path.join(out, 'vendor')";
  const start = source.indexOf(beginning);
  const end = source.indexOf(ending, start);
  assert.ok(
    start >= 0 && end > start,
    'locate the real build SHA rewrite loop',
  );
  assert.equal(source.indexOf(beginning, start + beginning.length), -1);
  const loop = source.slice(start, end);
  assert.ok(loop.trimEnd().endsWith('}'));

  const out = '/in-memory-wechat/dist';
  const target = path.join(out, contractLeaf);
  const files = new Map([[target, compiled]]);
  const reads: string[] = [];
  const writes: string[] = [];
  // Execute the actual allowlist and replacement statements, not a test-owned
  // rewrite. Other enrolled leaves are inert placeholders: none are transpiled.
  // The context cannot launch a process, copy assets, or touch real output files.
  await (vm.runInNewContext(
    `(async () => {\n${loop}\n})()`,
    {
      out,
      path,
      readFile: async (file: string, encoding: string) => {
        assert.equal(encoding, 'utf8');
        assert.ok(file.startsWith(out + path.sep));
        reads.push(file);
        return files.get(file) ?? 'module.exports = require("js-sha256");';
      },
      writeFile: async (file: string, content: string) => {
        assert.ok(reads.includes(file));
        writes.push(file);
        files.set(file, content);
      },
    },
    { filename: buildFile, timeout: 1_000 },
  ) as Promise<void>);
  assert.equal(
    reads.filter((file) => file === target).length,
    1,
    'the actual build allowlist must enroll the source contract exactly once',
  );
  assert.equal(writes.filter((file) => file === target).length, 1);
  const rewritten = files.get(target)!;
  assert.notEqual(rewritten, compiled);
  assert.match(rewritten, /require\(["']\.\.\/vendor\/sha256["']\)/);
  assert.doesNotMatch(rewritten, /require\(["']js-sha256(?:\/[^"']*)?["']\)/);
  return rewritten;
}

function nativeModules(files: ReadonlyMap<string, string>) {
  const cache = new Map<string, { exports: unknown }>();
  const requests: string[] = [];
  const load = (relative: string): unknown => {
    const previous = cache.get(relative);
    if (previous) return previous.exports;
    const source = files.get(relative);
    assert.notEqual(source, undefined, `unexpected native module ${relative}`);
    const module = { exports: {} as unknown };
    cache.set(relative, module);
    vm.runInNewContext(
      source!,
      {
        module,
        exports: module.exports,
        require: (specifier: string) => {
          requests.push(specifier);
          assert.ok(
            specifier.startsWith('./') || specifier.startsWith('../'),
            `native require must be relative: ${specifier}`,
          );
          const dependency = path.posix.normalize(
            path.posix.join(path.posix.dirname(relative), specifier + '.js'),
          );
          assert.ok(
            files.has(dependency),
            `unexpected native dependency ${dependency}`,
          );
          return load(dependency);
        },
      },
      { filename: relative, timeout: 1_000 },
    );
    return module.exports;
  };
  return { load, requests };
}

const digest = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

test('actual native SHA rewrite emits a relative-only source contract with Unicode/CRLF hash parity', async () => {
  const compiled = emitLeaf(contractLeaf);
  assert.match(
    compiled,
    /require\("js-sha256"\)/,
    'exercise real TypeScript-emitted bare SHA import before the build fix',
  );
  const errors = emitLeaf(errorsLeaf);
  const require = createRequire(__filename);
  // Exact vetted browser/CommonJS payload copied by build.mjs, never the npm
  // Node entry or a test substitute for SHA-256.
  const vendor = readFileSync(
    require.resolve('js-sha256/build/sha256.cjs'),
    'utf8',
  );
  assert.doesNotMatch(vendor, /require\s*\(/);
  const unrewritten = nativeModules(
    new Map([
      [contractLeaf, compiled],
      [errorsLeaf, errors],
      [vendorLeaf, vendor],
    ]),
  );
  assert.throws(
    () => unrewritten.load(contractLeaf),
    /native require must be relative: js-sha256/,
  );

  const emitted = await actualBuildRewrite(compiled);
  const runtime = nativeModules(
    new Map([
      [contractLeaf, emitted],
      [errorsLeaf, errors],
      [vendorLeaf, vendor],
    ]),
  );
  const native = runtime.load(contractLeaf) as NativeContract;
  const nativeErrors = runtime.load(errorsLeaf) as NativeErrors;
  assert.deepEqual(runtime.requests, ['../vendor/sha256', '../api/errors']);

  const formats: readonly TextSourceDescriptor[] = [
    { version: 1, format: 'plain', readingFormatting: 'auto' },
    { version: 1, format: 'plain', readingFormatting: 'off' },
    { version: 1, format: 'markdown' },
  ];
  const vectors = [
    '',
    '中文😀 café e\u0301\r\n第二行\t𝄞\r\n',
    '# 标题\r\n**👩‍👩‍👧‍👦**\r\n空格  \t保留\r\n',
    '末尾换行\r\n\r\n',
    '😀'.repeat(2_499) + '\r\n',
  ];
  for (const raw of vectors) {
    const canonical = raw.replace(/\r\n/g, '\n');
    assert.equal(native.canonicalSourceText(raw, 'post'), canonical);
    assert.equal(
      native.canonicalSourceText(raw, 'post'),
      canonicalSourceText(raw, 'post'),
    );
    for (const format of formats) {
      const expected = digest(
        'whaleu-community-text-source:v1\n' + format.format + '\n' + canonical,
      );
      assert.equal(native.textSourceHash(canonical, format), expected);
      assert.equal(
        native.textSourceHash(canonical, format),
        textSourceHash(canonical, format),
      );
      assert.match(expected, /^[0-9a-f]{64}$/);
      if (raw.includes('\r\n'))
        assert.notEqual(
          native.textSourceHash(raw, format),
          expected,
          'hash the exact input; canonicalization belongs to canonicalSourceText',
        );
      for (const operation of [
        'publish_post',
        'publish_comment',
        'publish_reply',
      ] as const) {
        const intent = { text: canonical, textSource: format };
        const expectedIntent = digest(
          'whaleu-community-text-source-intent:v1\n' +
            JSON.stringify({ operation, intent }),
        );
        assert.equal(
          native.textSourceIntentHash(operation, intent),
          expectedIntent,
        );
        assert.equal(
          native.textSourceIntentHash(operation, intent),
          textSourceIntentHash(operation, intent),
        );
      }
    }
    assert.equal(
      native.textSourceHash(canonical, formats[0]!),
      native.textSourceHash(canonical, formats[1]!),
    );
    assert.notEqual(
      native.textSourceHash(canonical, formats[0]!),
      native.textSourceHash(canonical, formats[2]!),
    );
  }

  for (const invalid of ['\ud800', '\udc00', 'unpaired\rreturn', '\u0000']) {
    assert.throws(
      () => native.canonicalSourceText(invalid, 'post'),
      (error: unknown) =>
        error instanceof nativeErrors.ClientError && error.kind === 'protocol',
    );
  }
  assert.throws(
    () => native.decodeTextSourceDescriptor({ version: 1, format: 'html' }),
    (error: unknown) =>
      error instanceof nativeErrors.ClientError && error.kind === 'protocol',
  );
  assert.deepEqual(
    runtime.requests,
    ['../vendor/sha256', '../api/errors'],
    'hashing and validation introduce no lazy bare imports or Node dependencies',
  );
});
