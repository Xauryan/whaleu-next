import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (file: string) => readFileSync(path.join(__dirname, '..', file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const homeReadableEvidenceRoot =
  'test/fixtures/reviewed-home-readable-successor';
export const homeReadablePaths = [
  'src/community/contract.ts',
  'src/community/gateway.ts',
  'src/community/search-contract.ts',
  'src/pages/community-search/community-search.ts',
  'src/category-reclassification/contract.ts',
] as const;
type HomeReadablePath = (typeof homeReadablePaths)[number];
interface Source {
  path: HomeReadablePath;
  before: string;
  after: string;
  beforeBytes: number;
  afterBytes: number;
  gitBlob: string;
  evidence: string;
}
interface Manifest {
  predecessorCommit: string;
  readingManifestSha256: string;
  sources: Source[];
  unchanged: { path: string; sha256: string; bytes: number }[];
  patchSha256: string;
}
const unchangedPaths = [
  ...[
    'community-feed',
    'inbox',
    'me',
    'community-compose',
    'community-detail',
    'community-thread',
    'community-search',
  ].flatMap((page) =>
    [
      `${page}.json`,
      `${page}.ts`,
      `${page}.wxml`,
      `${page}.wxss`,
      'controller.ts',
    ]
      .filter(
        (file) =>
          !(page === 'community-search' && file === `${page}.ts`) &&
          !(page === 'inbox' && file === 'controller.ts'),
      )
      .map((file) => `src/pages/${page}/${file}`),
  ),
  'test/fixtures/core-product-action-inventory.json',
  ...['composer', 'forms', 'collections', 'notifications', 'support'].flatMap(
    (family) =>
      ['actions', 'protected'].map(
        (kind) => `test/fixtures/framework7-${family}-before-${kind}.json`,
      ),
  ),
  'test/framework7-action-parity.ts',
  'scripts/preview-wxml.mjs',
];
function manifest(readSource: (file: string) => Buffer): Manifest {
  const bytes = readSource(`${homeReadableEvidenceRoot}/manifest.json`);
  assert.equal(
    sha(bytes),
    '5092f7b78ba17eb129479e3a4240dcbe702f32f53aee6ecad20e158402c6d8b3',
    'immutable Home readable successor manifest',
  );
  const proof = JSON.parse(bytes.toString('utf8')) as Manifest;
  assert.equal(
    proof.predecessorCommit,
    '89e829a10b664d300089e531e3b0b9cef17fa60d',
  );
  assert.deepEqual(
    proof.sources.map((entry) => entry.path),
    homeReadablePaths,
  );
  assert.deepEqual(
    proof.unchanged.map((entry) => entry.path),
    unchangedPaths,
  );
  return proof;
}
export const homeReadableSuccessors = manifest(read).sources;
export const homeReadableProofPaths = [
  `${homeReadableEvidenceRoot}/manifest.json`,
  `${homeReadableEvidenceRoot}/correction.patch`,
  ...homeReadableSuccessors.map(
    (entry) => `${homeReadableEvidenceRoot}/${entry.evidence}`,
  ),
];

/** Every substitution has a unique context, including the two response owners
 * and the two gateway signatures. Neither a category-array edit nor a generic
 * isCategory replacement is admitted. Full forward and reverse reconstruction
 * reject added/removed text, duplicate matches, and unrelated source changes. */
export const homeReadableCorrections: Readonly<
  Record<HomeReadablePath, readonly (readonly [string, string])[]>
> = {
  'src/community/contract.ts': [
    [
      'export type Category = (typeof categories)[number];',
      "/** Client publication vocabulary. System placements are never write intents. */\nexport type Category = (typeof categories)[number];\nexport type ReadableCategory = Category | 'water';",
    ],
    [
      '    readonly name: string;\n  };\n  readonly category: Category;\n  readonly text: string;',
      '    readonly name: string;\n  };\n  readonly category: ReadableCategory;\n  readonly text: string;',
    ],
    [
      "  readonly category: Category;\n  readonly status: 'published' | 'hidden' | 'deleted';",
      "  readonly category: ReadableCategory;\n  readonly status: 'published' | 'hidden' | 'deleted';",
    ],
    [
      "export const isCategory = (value: unknown): value is Category =>\n  typeof value === 'string' && categories.includes(value as Category);",
      "export const isCategory = (value: unknown): value is Category =>\n  typeof value === 'string' && categories.includes(value as Category);\n/** Bounded response vocabulary, separate from client publication authority. */\nexport const isReadableCategory = (value: unknown): value is ReadableCategory =>\n  value === 'water' || isCategory(value);",
    ],
    [
      '    !boundedText(value.space.name, 1, 200) ||\n    !isCategory(value.category) ||',
      '    !boundedText(value.space.name, 1, 200) ||\n    !isReadableCategory(value.category) ||',
    ],
    [
      '      !isCategory(item.category) ||',
      '      !isReadableCategory(item.category) ||',
    ],
  ],
  'src/community/gateway.ts': [
    [
      '  isCategory,\n  uuid4,',
      '  isCategory,\n  isReadableCategory,\n  uuid4,',
    ],
    [
      '  type Category,\n  type CommentIntent,',
      '  type Category,\n  type ReadableCategory,\n  type CommentIntent,',
    ],
    [
      '  textSourceCapabilities?(\n    spaceId: string,\n    category: Category,',
      '  textSourceCapabilities?(\n    spaceId: string,\n    category: ReadableCategory,',
    ],
    [
      '  async textSourceCapabilities(\n    spaceId: string,\n    category: Category,',
      '  async textSourceCapabilities(\n    spaceId: string,\n    category: ReadableCategory,',
    ],
    [
      "    if (!isCategory(category) || !['named', 'anonymous'].includes(authorMode))",
      "    if (\n      !isReadableCategory(category) ||\n      !['named', 'anonymous'].includes(authorMode)\n    )",
    ],
  ],
  'src/community/search-contract.ts': [
    [
      '  isCategory,\n  type Category,\n  type Author,',
      '  isCategory,\n  isReadableCategory,\n  type Category,\n  type ReadableCategory,\n  type Author,',
    ],
    [
      '  readonly category: Category;',
      '  readonly category: ReadableCategory;',
    ],
    [
      '    !isCategory(value.category) ||',
      '    !isReadableCategory(value.category) ||',
    ],
  ],
  'src/pages/community-search/community-search.ts': [
    [
      '    categoryLabels: {\n',
      "    categoryLabels: {\n      water: '水区',\n",
    ],
  ],
  'src/category-reclassification/contract.ts': [
    [
      "import { exact, isCategory, timestamp, uuid4 } from '../community/contract';\nimport type { Category } from '../community/contract';",
      "import {\n  exact,\n  isReadableCategory,\n  timestamp,\n  uuid4,\n} from '../community/contract';\nimport type { ReadableCategory } from '../community/contract';",
    ],
    [
      "export const reclassificationLabels: Readonly<Record<Category, string>> = {\n  discussion: '校园讨论',",
      "export const reclassificationLabels: Readonly<\n  Record<ReadableCategory, string>\n> = {\n  discussion: '校园讨论',\n  water: '水区',",
    ],
    [
      '  readonly currentCategory: Category;',
      '  readonly currentCategory: ReadableCategory;',
    ],
    [
      '    !isCategory(raw.currentCategory) ||',
      '    !isReadableCategory(raw.currentCategory) ||',
    ],
    [
      '      (!isReclassificationCategory(raw.currentCategory) ||',
      "      ((raw.currentCategory !== 'water' &&\n        !isReclassificationCategory(raw.currentCategory)) ||",
    ],
  ],
};
export function assertHomeReadableDelta(
  file: string,
  before: string,
  current: string,
): void {
  const key = homeReadablePaths.find((candidate) => file === candidate);
  assert.ok(key, 'only five exact readable Home source owners');
  let forward = before;
  for (const [old, next] of homeReadableCorrections[key]) {
    assert.equal(
      forward.split(old).length,
      2,
      `${file}: one forward correction`,
    );
    forward = forward.replace(old, next);
  }
  let reverse = current;
  for (const [old, next] of [...homeReadableCorrections[key]].reverse()) {
    assert.equal(
      reverse.split(next).length,
      2,
      `${file}: one reverse correction`,
    );
    reverse = reverse.replace(next, old);
  }
  assert.equal(
    forward,
    current,
    `${file}: exact complete forward source delta`,
  );
  assert.equal(reverse, before, `${file}: exact complete reverse source delta`);
}

function authenticate(
  readSource: (file: string) => Buffer,
): Map<string, Buffer> {
  const proof = manifest(readSource);
  const readingBytes = readSource(
    'test/fixtures/reviewed-reading-successor/manifest.json',
  );
  assert.equal(
    sha(readingBytes),
    proof.readingManifestSha256,
    'immutable reading source seal',
  );
  const reading = JSON.parse(readingBytes.toString('utf8')) as {
    sources: { path: string; after: string }[];
  };
  assert.equal(
    sha(readSource(`${homeReadableEvidenceRoot}/correction.patch`)),
    proof.patchSha256,
    'immutable readable Home delta',
  );
  const predecessors = new Map<string, Buffer>();
  for (const entry of proof.sources) {
    assert.equal(entry.evidence, `before/${entry.path}.txt`);
    const before = readSource(`${homeReadableEvidenceRoot}/${entry.evidence}`);
    assert.equal(
      sha(before),
      entry.before,
      `${entry.path}: exact 89e predecessor`,
    );
    assert.equal(before.length, entry.beforeBytes);
    assert.equal(
      createHash('sha1')
        .update(`blob ${before.length}\0`)
        .update(before)
        .digest('hex'),
      entry.gitBlob,
      `${entry.path}: exact 89e Git blob`,
    );
    if (
      ['src/community/contract.ts', 'src/community/gateway.ts'].includes(
        entry.path,
      )
    )
      assert.equal(
        entry.before,
        reading.sources.find((source) => source.path === entry.path)!.after,
        `${entry.path}: exact reading-after to Home-before join`,
      );
    const live = readSource(entry.path);
    assert.equal(
      sha(live),
      entry.after,
      `${entry.path}: exact readable Home successor`,
    );
    assert.equal(live.length, entry.afterBytes);
    assertHomeReadableDelta(
      entry.path,
      before.toString('utf8'),
      live.toString('utf8'),
    );
    predecessors.set(entry.path, before);
  }
  for (const entry of proof.unchanged) {
    const bytes = readSource(entry.path);
    assert.equal(
      sha(bytes),
      entry.sha256,
      `${entry.path}: unchanged accepted presentation and actions`,
    );
    assert.equal(bytes.length, entry.bytes);
  }
  return predecessors;
}
const keyFor = (file: string) =>
  homeReadablePaths.find(
    (key) => file === key || file === `apps/wechat/${key}`,
  );

/** Only the exact immediate 89e predecessor hash is superseded. Unknown paths,
 * arbitrary aliases and older historical hashes do not access any proof. */
export function assertReviewedHomeReadableSuccessor(
  file: string,
  expected: string,
  readSource: (file: string) => Buffer = read,
): boolean {
  const key = keyFor(file);
  const entry = homeReadableSuccessors.find((source) => source.path === key);
  if (!entry || expected !== entry.before) return false;
  authenticate(readSource);
  return true;
}
export function homeReadablePredecessor(
  file: string,
  current: Buffer,
  readSource: (file: string) => Buffer = read,
): Buffer {
  const key = keyFor(file);
  if (!key) return current;
  const entry = homeReadableSuccessors.find((source) => source.path === key)!;
  assert.equal(
    sha(current),
    entry.after,
    `${key}: exact supplied Home successor`,
  );
  return authenticate(readSource).get(key)!;
}
