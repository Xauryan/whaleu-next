import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

test('build runs the native press smoke once against its completed emitted artifacts', async () => {
  const root = path.resolve(__dirname, '..');
  const buildFile = path.join(root, 'scripts/build.mjs');
  const out = path.join(root, 'dist');
  const smokeFile = path.join(root, 'test/native-press-emitted.smoke.mjs');
  const events: string[] = [];
  const calls: {
    file: string;
    args: string[];
    options: {
      stdio: string;
      cwd?: string;
      env?: Record<string, string>;
    };
    index: number;
  }[] = [];
  const inheritedEnv = {
    PATH: '/inherited/path',
    WHALEU_WECHAT_DIST: '/stale/unrelated/dist',
  };
  const resolve = (specifier: string) =>
    path.join(root, 'node_modules', specifier);

  // Execute the real build control flow with every filesystem mutation and
  // subprocess mocked. No compiler, dist artifacts, or smoke is executed here.
  const source = readFileSync(buildFile, 'utf8')
    .replace(/^import[\s\S]*?from 'node:[^']+';\r?\n/gm, '')
    .replace(/import\.meta\.url/g, 'buildUrl');
  await (vm.runInNewContext(
    `(async () => {\n${source}\n})()`,
    {
      buildUrl: pathToFileURL(buildFile).href,
      path,
      fileURLToPath,
      process: { execPath: process.execPath, env: inheritedEnv },
      createRequire: () => ({ resolve }),
      execFileSync: (
        file: string,
        args: string[],
        options: (typeof calls)[number]['options'],
      ) => {
        calls.push({
          ...structuredClone({ file, args, options }),
          index: events.length,
        });
        events.push(`exec:${args[args.length - 1]}`);
      },
      rm: async (target: string) => {
        events.push(`rm:${target}`);
      },
      mkdir: async (target: string) => {
        events.push(`mkdir:${target}`);
      },
      readdir: async () =>
        ['app.json', 'app.wxml', 'app.wxss', 'icon.png'].map((name) => ({
          name,
          isDirectory: () => false,
        })),
      cp: async (_from: string, to: string) => {
        events.push(`cp:${to}`);
      },
      readFile: async () => 'const sha256 = require("js-sha256");',
      writeFile: async (target: string) => {
        events.push(`write:${target}`);
      },
    },
    { filename: buildFile },
  ) as Promise<void>);

  const enrolled = calls.filter(({ args }) => args.includes(smokeFile));
  assert.equal(enrolled.length, 1, 'the emitted smoke must run exactly once');
  const smoke = enrolled[0]!;
  assert.equal(smoke.file, process.execPath);
  assert.deepEqual(smoke.args, ['--import', 'tsx', '--test', smokeFile]);
  assert.deepEqual(smoke.options, {
    stdio: 'inherit',
    cwd: root,
    env: { ...inheritedEnv, WHALEU_WECHAT_DIST: out },
  });
  assert.equal(inheritedEnv.WHALEU_WECHAT_DIST, '/stale/unrelated/dist');

  const compiler = calls.find(({ args }) =>
    args.includes(resolve('typescript/bin/tsc')),
  );
  assert.ok(compiler && compiler.index < smoke.index);
  for (const artifact of [
    'app.json',
    'app.wxml',
    'app.wxss',
    'icon.png',
    'vendor/sha256.js',
    'vendor/js-sha256-LICENSE.txt',
  ]) {
    const copied = events.indexOf(`cp:${path.join(out, artifact)}`);
    assert.ok(copied >= 0 && copied < smoke.index, artifact);
  }
  assert.ok(events.some((event) => event.startsWith('write:')));
  assert.ok(
    events.slice(smoke.index + 1).every((event) => event.startsWith('exec:')),
    'all native emission and rewrite steps must finish before the smoke',
  );
  const smokeIndex = calls.indexOf(smoke);
  assert.deepEqual(calls[smokeIndex - 1]?.args, [
    path.join(root, 'scripts/smoke-build.mjs'),
  ]);
  assert.deepEqual(calls[smokeIndex + 1]?.args, [
    '--import',
    'tsx',
    path.join(root, 'test/rating-target-cover-page-smoke.mjs'),
  ]);
});
