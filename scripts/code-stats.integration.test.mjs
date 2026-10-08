import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  buildSite,
  countBranches,
  listBranches,
  countRepository,
} from './code-stats.mjs';
import { excluded } from './code-stats.fixtures.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';

test('real cloc 2.10 counts immutable Git source, WXML/WXSS and duplicates; publishes only SVG', () => {
  assert.ok(
    process.env.CLOC_PATH,
    'CLOC_PATH is required for the real-cloc integration gate',
  );
  const root = mkdtempSync(join(tmpdir(), 'whaleu-stats-test-'));
  const repository = join(root, 'repository');
  mkdirSync(repository);
  const git = (...args) =>
    execFileSync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const put = (path, text) => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), text);
  };
  try {
    git('init', '--quiet', '--initial-branch=main');
    const fixtures = {
      'apps/wechat/view.wxml': '<!-- comment -->\n\n<view>WhaleU</view>\n',
      'apps/wechat/app.wxss': '/* comment */\n\npage {\n  color: red;\n}\n',
      'apps/api/src/main.ts': '// comment\n\nexport const value = 1;\n',
      'apps/api/test/main.test.ts': '// comment\n\nexport const value = 1;\n',
      'scripts/task.mjs':
        'throw new Error("Branch files must never execute");\n',
      'apps/api/migrations/001.sql': '-- comment\nSELECT 1;\n',
      'config/settings.json': '{"enabled":true}\n',
      'package.json': '{"private":true}\n',
      '.github/workflows/ci.yml': 'name: fixture\non: push\n',
    };
    for (const [path, content] of Object.entries(fixtures)) put(path, content);
    for (const path of excluded.filter((path) => !path.includes('..')))
      put(path, 'export const excluded = 100;\n');
    writeFileSync(join(root, 'outside.ts'), 'export const outside = 100;\n');
    symlinkSync(
      join(root, 'outside.ts'),
      join(repository, 'apps/api/src/symlink.ts'),
    );
    git('add', '--all');
    git(
      '-c',
      'user.name=Stats fixture',
      '-c',
      'user.email=stats@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Test fixture',
    );
    const committedSha = git('rev-parse', 'HEAD').trim();
    git('branch', 'rewrite/backend-foundation');
    git('branch', 'duplicate');
    const hostileBranch = 'feature/<script>&"';
    const injectionBranch = 'feature/$(touch${IFS}INJECTION)';
    git('branch', hostileBranch);
    git('branch', injectionBranch);
    const emptyTree = git('mktree').trim();
    const emptySha = git(
      '-c',
      'user.name=Stats fixture',
      '-c',
      'user.email=stats@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit-tree',
      emptyTree,
      '-m',
      'Empty branch',
    ).trim();
    git('update-ref', 'refs/heads/empty', emptySha);
    const emptyBlob = git('hash-object', '-w', '--stdin').trim();
    const binaryBlob = execFileSync(
      'git',
      ['-C', repository, 'hash-object', '-w', '--stdin'],
      {
        input: Buffer.from(
          Array.from({ length: 8192 }, (_, index) => index % 256),
        ),
        encoding: 'utf8',
      },
    ).trim();
    const binaryTree = execFileSync('git', ['-C', repository, 'mktree'], {
      input: `100644 blob ${emptyBlob}\tempty.ts\n100644 blob ${binaryBlob}\tbinary.ts\n`,
      encoding: 'utf8',
    }).trim();
    const emptyBinarySha = git(
      '-c',
      'user.name=Stats fixture',
      '-c',
      'user.email=stats@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit-tree',
      binaryTree,
      '-m',
      'Empty and binary eligible files',
    ).trim();
    git('update-ref', 'refs/heads/empty-and-binary', emptyBinarySha);

    const remote = join(root, 'origin.git');
    execFileSync('git', ['clone', '--quiet', '--bare', repository, remote]);
    git('remote', 'add', 'origin', remote);
    const refresh = () =>
      git(
        'fetch',
        '--force',
        '--prune',
        '--no-tags',
        '--depth=1',
        'origin',
        '+refs/heads/*:refs/remotes/origin/*',
      );
    refresh();
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git('branch', 'local-only');
    git('tag', 'not-a-branch');
    assert.equal(listBranches(repository, 'main').length, 7);
    assert.equal(listBranches(repository, 'main')[0].name, 'main');
    assert.throws(
      () => listBranches(repository, 'missing-default'),
      /actual default branch/,
    );

    put(
      'apps/api/src/main.ts',
      'export const changed = 2;\nexport const changedAgain = 3;\n',
    );
    put('apps/api/src/untracked.ts', 'export const untracked = 1;\n');
    put('apps/api/src/staged.ts', 'export const staged = 1;\n');
    git('add', 'apps/api/src/staged.ts');
    const clocPath = process.env.CLOC_PATH;
    const stats = countRepository(repository, clocPath);
    assert.equal(stats.sha, committedSha);
    assert.equal(stats.files, 9);
    assert.equal(stats.code, 12);
    assert.equal(stats.languages.length, 7);
    assert.deepEqual(
      stats.languages.find((language) => language.name === 'WXML'),
      { name: 'WXML', files: 1, code: 1 },
    );
    assert.deepEqual(
      stats.languages.find((language) => language.name === 'WXSS'),
      { name: 'WXSS', files: 1, code: 3 },
    );
    assert.deepEqual(
      stats.languages.find((language) => language.name === 'TypeScript'),
      { name: 'TypeScript', files: 2, code: 2 },
    );
    const outputDirectory = join(root, 'site');
    buildSite({
      repository,
      clocPath,
      outputDirectory,
      defaultBranch: 'main',
      expectedSha: committedSha,
    });
    assert.deepEqual(readdirSync(outputDirectory), ['code-stats.svg']);
    const branches = countBranches(repository, clocPath, 'main');
    assert.equal(branches[0].name, 'main');
    assert.equal(branches.length, 7);
    for (const branch of branches.filter(
      (branch) => !['empty', 'empty-and-binary'].includes(branch.name),
    )) {
      assert.equal(branch.code, 12);
      assert.equal(branch.files, 9);
      assert.equal(branch.sha, committedSha);
    }
    assert.deepEqual(
      branches.find((branch) => branch.name === 'empty'),
      { name: 'empty', sha: emptySha, code: 0, files: 0, languages: [] },
    );
    assert.deepEqual(
      branches.find((branch) => branch.name === 'empty-and-binary'),
      {
        name: 'empty-and-binary',
        sha: emptyBinarySha,
        code: 0,
        files: 0,
        languages: [],
      },
    );
    const svg = readFileSync(join(outputDirectory, 'code-stats.svg'), 'utf8');
    assert.ok(svg.includes('main · default'));
    assert.ok(svg.includes('feature/&lt;script&gt;&amp;&quot;'));
    assert.ok(svg.includes('No counted source files'));
    assert.ok(svg.includes('counted independently, never summed'));
    assert.doesNotMatch(svg, /72 code lines|<script\b/);
    assert.equal(readdirSync(repository).includes('INJECTION'), false);
    execFileSync('git', [
      '-C',
      remote,
      'update-ref',
      '-d',
      'refs/heads/duplicate',
    ]);
    refresh();
    assert.equal(listBranches(repository, 'main').length, 6);
    assert.equal(
      countBranches(repository, clocPath, 'main').some(
        (branch) => branch.name === 'duplicate',
      ),
      false,
    );
    assert.throws(
      () => countRepository(repository, clocPath, 'HEAD;touch INJECTION'),
      /Invalid source SHA/,
    );

    assert.ok(
      readFileSync(join(outputDirectory, 'code-stats.svg'), 'utf8').includes(
        committedSha,
      ),
    );
    assert.throws(
      () =>
        buildSite({
          repository,
          clocPath,
          outputDirectory,
          defaultBranch: 'main',
          expectedSha: sha,
        }),
      /differs/,
    );
    assert.throws(
      () =>
        buildSite({
          repository,
          clocPath,
          outputDirectory,
          defaultBranch: 'main',
        }),
      /EEXIST/,
    );
    const fakeCloc = join(root, 'fake-cloc.pl');
    writeFileSync(fakeCloc, 'die "must not execute";');
    assert.throws(
      () => countRepository(repository, fakeCloc),
      /checksum mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
