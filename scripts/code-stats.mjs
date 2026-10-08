import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOC_SHA256 =
  'bf59272455172108072a0a106379f7509fd4349bdcfd85203bac038ccd286d83';
const sourceRoots = new Set([
  'apps',
  'packages',
  'scripts',
  'tests',
  'test',
  'migrations',
  'config',
  '.github',
]);
const excludedDirectories = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  'docs',
  'documentation',
  'generated',
  '__generated__',
  '_generated',
  '.openapi-build',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.git',
]);
const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.sql',
  '.wxml',
  '.wxss',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.bash',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.graphql',
  '.gql',
]);
const lockfiles = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'gemfile.lock',
  'pipfile.lock',
]);

export function isCountedPath(path) {
  const parts = path.split('/');
  const name = basename(path).toLowerCase();
  if (parts.some((part) => !part || part === '.' || part === '..'))
    return false;
  if (parts.length > 1 && !sourceRoots.has(parts[0])) return false;
  if (
    parts
      .slice(0, -1)
      .some((part) => excludedDirectories.has(part.toLowerCase()))
  )
    return false;
  if (lockfiles.has(name) || /\.(?:min|generated|gen)\./i.test(name))
    return false;
  if (
    /(?:^|[._-])openapi(?:[._-]|$)/i.test(name) &&
    /\.(?:json|ya?ml)$/.test(name)
  )
    return false;
  return sourceExtensions.has(extname(name)) || name === 'dockerfile';
}

function runGit(repository, args, options = {}) {
  return execFileSync('git', ['-C', repository, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

export function summarize(report) {
  // cloc 2.10 emits exactly {} when every eligible file is empty or binary.
  if (
    report &&
    Object.getPrototypeOf(report) === Object.prototype &&
    Object.keys(report).length === 0
  ) {
    return { code: 0, files: 0, languages: [] };
  }
  const languages = Object.entries(report)
    .filter(([name]) => name !== 'header' && name !== 'SUM')
    .map(([name, value]) => {
      for (const key of ['nFiles', 'code', 'comment', 'blank']) {
        if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
          throw new Error(`Invalid cloc ${key} count`);
        }
      }
      return { name, files: value.nFiles, code: value.code };
    })
    .sort((a, b) => b.code - a.code || a.name.localeCompare(b.name, 'en'));
  const total = languages.reduce(
    (sum, item) => ({
      files: sum.files + item.files,
      code: sum.code + item.code,
    }),
    { files: 0, code: 0 },
  );
  if (
    !report.SUM ||
    total.files !== report.SUM.nFiles ||
    total.code !== report.SUM.code
  ) {
    throw new Error('cloc totals do not match language counts');
  }
  return { ...total, languages };
}

function isSha(value) {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
}

export function countRepository(repository, clocPath, sourceSha) {
  const checksum = createHash('sha256')
    .update(readFileSync(clocPath))
    .digest('hex');
  if (checksum !== CLOC_SHA256) throw new Error('cloc 2.10 checksum mismatch');
  const sha =
    sourceSha ||
    runGit(repository, ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  if (!isSha(sha)) throw new Error('Invalid source SHA');
  const entries = runGit(
    repository,
    ['ls-tree', '-r', '--full-tree', '-z', sha],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      const [mode, type, oid] = entry.slice(0, tab).split(' ');
      return { mode, type, oid, path: entry.slice(tab + 1) };
    })
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        /^100(?:644|755)$/.test(entry.mode) &&
        isCountedPath(entry.path),
    );
  if (!entries.length) return { sha, code: 0, files: 0, languages: [] };
  // Read immutable Git blobs, not untracked files, working-tree edits, symlinks or submodules.
  const blobs = runGit(repository, ['cat-file', '--batch'], {
    input: entries.map((entry) => `${entry.oid}\n`).join(''),
  });
  const staging = mkdtempSync(join(tmpdir(), 'whaleu-code-stats-'));
  try {
    let offset = 0;
    for (const entry of entries) {
      const end = blobs.indexOf(10, offset);
      const [oid, type, rawSize] = blobs
        .subarray(offset, end)
        .toString()
        .split(' ');
      const size = Number(rawSize);
      if (
        end < offset ||
        oid !== entry.oid ||
        type !== 'blob' ||
        !Number.isSafeInteger(size) ||
        size < 0
      ) {
        throw new Error('Invalid Git blob response');
      }
      offset = end + 1;
      if (offset + size >= blobs.length || blobs[offset + size] !== 10)
        throw new Error('Truncated Git blob');
      const destination = join(staging, entry.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, blobs.subarray(offset, offset + size));
      offset += size + 1;
    }
    const report = JSON.parse(
      execFileSync(
        'perl',
        [
          resolve(clocPath),
          '--json',
          '--quiet',
          '--hide-rate',
          '--skip-uniqueness',
          staging,
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      ),
    );
    return { sha, ...summarize(report) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function escapeXml(value) {
  return [...String(value)]
    .filter((character) => {
      const code = character.codePointAt(0);
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      );
    })
    .join('')
    .replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&apos;',
        })[character],
    );
}

export function listBranches(repository, defaultBranch) {
  const prefix = 'refs/remotes/origin/';
  const branches = runGit(
    repository,
    [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)',
      prefix,
    ],
    { encoding: 'utf8' },
  )
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, type, symbolic] = line.split('\0');
      return { name: ref.slice(prefix.length), sha, type, symbolic };
    })
    .filter((branch) => !branch.symbolic)
    .map(({ name, sha, type }) => {
      if (type !== 'commit' || !isSha(sha))
        throw new Error('Branch tip is not a commit');
      return { name, sha };
    });
  if (
    !defaultBranch ||
    !branches.some((branch) => branch.name === defaultBranch)
  ) {
    throw new Error(
      'The actual default branch must be present in the fetched origin snapshot',
    );
  }
  return branches.sort(
    (a, b) =>
      Number(b.name === defaultBranch) - Number(a.name === defaultBranch) ||
      a.name.localeCompare(b.name, 'en'),
  );
}

export function countBranches(repository, clocPath, defaultBranch) {
  const branches = listBranches(repository, defaultBranch);
  const counts = new Map();
  return branches.map((branch) => {
    // Reuse identical commit calculations without adding branch counts together.
    if (!counts.has(branch.sha))
      counts.set(branch.sha, countRepository(repository, clocPath, branch.sha));
    return { name: branch.name, ...counts.get(branch.sha) };
  });
}

export function renderSvg(branches, defaultBranch) {
  const number = (value) => value.toLocaleString('en-US');
  const palette = [
    '#3178c6',
    '#e5b84b',
    '#b38cf2',
    '#56b9ae',
    '#ef8a78',
    '#76a6da',
  ];
  let y = 78;
  const sections = branches
    .map((stats) => {
      if (!isSha(stats.sha)) throw new Error('Invalid source SHA');
      const label =
        stats.name + (stats.name === defaultBranch ? ' · default' : '');
      const characters = [...label];
      const labels = [];
      for (let i = 0; i < characters.length; i += 70)
        labels.push(characters.slice(i, i + 70).join(''));
      const name = labels
        .map((line) => {
          const text = `<text x="26" y="${y}" font-size="14" font-weight="650">${escapeXml(line)}</text>`;
          y += 20;
          return text;
        })
        .join('\n');
      const metadata = `<text x="26" y="${y}" font-size="11" fill="#b7c6d8">${stats.sha.slice(0, 12)}</text>`;
      y += 29;
      const summary = `<text x="26" y="${y}" font-size="20" font-weight="650">${number(stats.code)} <tspan font-size="12" font-weight="400">code lines</tspan></text>
  <text x="315" y="${y}" font-size="20" font-weight="650">${number(stats.files)} <tspan font-size="12" font-weight="400">files</tspan></text>
  <text x="565" y="${y}" font-size="20" font-weight="650">${stats.languages.length} <tspan font-size="12" font-weight="400">languages</tspan></text>`;
      y += 26;
      let rows;
      if (!stats.languages.length) {
        rows = `<text x="26" y="${y}" font-size="12" fill="#b7c6d8">No counted source files in this branch.</text>`;
        y += 24;
      } else {
        rows = `<g fill="#b7c6d8" font-size="10"><text x="26" y="${y}">LANGUAGE</text><text x="587" y="${y}" text-anchor="end">CODE LINES</text><text x="732" y="${y}" text-anchor="end">FILES</text></g>`;
        y += 23;
        rows += stats.languages
          .map((language, index) => {
            const bar = stats.code
              ? Math.round((language.code / stats.code) * 270)
              : 0;
            const row = `<text x="26" y="${y}" font-size="12">${escapeXml(language.name)}</text>
  <rect x="200" y="${y - 9}" width="${bar}" height="9" rx="4" fill="${palette[index % palette.length]}"/>
  <text x="587" y="${y}" text-anchor="end" font-size="12">${number(language.code)}</text>
  <text x="732" y="${y}" text-anchor="end" font-size="12">${number(language.files)}</text>`;
            y += 24;
            return row;
          })
          .join('\n');
      }
      const divider = `<path d="M26 ${y - 7}H734" stroke="#344456"/>`;
      y += 19;
      return (
        name + '\n' + metadata + '\n' + summary + '\n' + rows + '\n' + divider
      );
    })
    .join('\n');
  const height = y + 17;
  const description = branches
    .map(
      (stats) =>
        `${stats.name}${stats.name === defaultBranch ? ' (default)' : ''}: ${number(stats.code)} code lines, ${number(stats.files)} files, ${stats.languages.length} languages; source ${stats.sha}.`,
    )
    .join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${height}" viewBox="0 0 760 ${height}" role="img" aria-labelledby="title description">
  <title id="title">WhaleU Next code statistics by branch</title>
  <desc id="description">${escapeXml(description)} Branches are counted independently, never summed. Blank and comment-only lines are excluded.</desc>
  <rect x="0.5" y="0.5" width="759" height="${height - 1}" rx="12" fill="#101923" stroke="#344456"/>
  <g font-family="system-ui, -apple-system, Segoe UI, sans-serif" fill="#e7edf5">
  <text x="26" y="31" font-size="18" font-weight="650">Code statistics by branch</text>
  <text x="26" y="52" font-size="11" fill="#b7c6d8">${branches.length} branch snapshots · counted independently, never summed</text>
${sections}
  <text x="26" y="${y}" font-size="10" fill="#b7c6d8">cloc 2.10 · committed source, tests, scripts, migrations and configuration</text>
  </g>
</svg>\n`;
}

export function buildSite({
  repository,
  clocPath,
  outputDirectory,
  defaultBranch,
  expectedSha,
}) {
  const publisherSha = runGit(repository, ['rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (expectedSha && publisherSha !== expectedSha)
    throw new Error('Publisher SHA differs from workflow SHA');
  const branches = countBranches(repository, clocPath, defaultBranch);
  const svg = renderSvg(branches, defaultBranch);
  // Fail on an existing directory: nothing except this SVG may enter the Pages artifact.
  mkdirSync(outputDirectory);
  writeFileSync(join(outputDirectory, 'code-stats.svg'), svg, { flag: 'wx' });
  return { branches, defaultBranch, publisherSha };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (
    !process.env.CLOC_PATH ||
    !process.env.STATS_OUTPUT_DIR ||
    !process.env.STATS_DEFAULT_BRANCH
  ) {
    throw new Error(
      'Set CLOC_PATH, STATS_DEFAULT_BRANCH and STATS_OUTPUT_DIR (a new, isolated directory)',
    );
  }
  const result = buildSite({
    repository: process.cwd(),
    clocPath: process.env.CLOC_PATH,
    outputDirectory: resolve(process.env.STATS_OUTPUT_DIR),
    defaultBranch: process.env.STATS_DEFAULT_BRANCH,
    expectedSha: process.env.STATS_SHA,
  });
  for (const stats of result.branches)
    console.log(
      `${JSON.stringify(stats.name)}: ${stats.code} lines, ${stats.files} files, ${stats.languages.length} languages; source ${stats.sha}`,
    );
}
