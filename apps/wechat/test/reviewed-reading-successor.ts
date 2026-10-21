import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { PresentationNode } from './framework7-action-parity';
import { assertReviewedBusinessSuccessor as originalBusiness } from './reviewed-business-successor';
import {
  assertReferenceActionDelta,
  assertReviewedReferenceSuccessor as originalReference,
  referenceEvidenceRoot,
  referencePage,
  referenceSuccessors,
} from './reviewed-reference-successor';
export {
  assertReferenceActionDelta,
  referenceEvidenceRoot,
  referencePage,
  referenceSuccessors,
};
const read = (file: string) => readFileSync(path.join(__dirname, '..', file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const readingEvidenceRoot = 'test/fixtures/reviewed-reading-successor';
const manifestHash =
  '3b7a3281fbf23af3f88fedd64614f8ab935977cc71b6a0dcf887153b3979bec2';
const predecessorHash =
  '861aafeebb8abcd98e0cd37b1e2bb8ef7f41d03707cc1c59ff6aee1e4900b096';
const paths = [
  'scripts/build.mjs',
  'src/community/contract.ts',
  'src/community/discussion-contract.ts',
  'src/community/gateway.ts',
  'src/community/pending-attempt.ts',
  'src/community/review-contract.ts',
  'src/media/batch-controller.ts',
  'src/media/batch-publication.ts',
  'src/media/upload-controller.ts',
  'src/media/upload-runtime.ts',
  ...['community-compose', 'community-detail', 'community-thread'].flatMap(
    (page) => [
      `src/pages/${page}/${page}.json`,
      `src/pages/${page}/${page}.ts`,
      `src/pages/${page}/${page}.wxml`,
      `src/pages/${page}/controller.ts`,
    ],
  ),
];
const addedPaths = [
  'src/community/reading-contract.ts',
  'src/community/reading-gateway.ts',
  'src/community/text-source-contract.ts',
  'src/community/text-source-read-contract.ts',
  'src/community/text-source-renderer.ts',
  ...['json', 'ts', 'wxml', 'wxss'].map(
    (ext) => `src/components/source-text/source-text.${ext}`,
  ),
];
interface Source {
  path: string;
  before: string;
  after: string;
  beforeBytes: number;
  evidence: string;
  reason: string;
}
interface Manifest {
  predecessorManifestSha256: string;
  sources: Source[];
  added: { path: string; sha256: string }[];
  patchSha256: string;
}
function manifest(readSource: (file: string) => Buffer): Manifest {
  const bytes = readSource(`${readingEvidenceRoot}/manifest.json`);
  assert.equal(
    sha(bytes),
    manifestHash,
    'immutable reading successor manifest',
  );
  const result = JSON.parse(bytes.toString('utf8')) as Manifest;
  assert.equal(result.predecessorManifestSha256, predecessorHash);
  assert.deepEqual(
    result.sources.map((entry) => entry.path).sort(),
    [...paths].sort(),
  );
  assert.deepEqual(
    result.added.map((entry) => entry.path).sort(),
    [...addedPaths].sort(),
  );
  return result;
}
export const readingSuccessors = manifest(read).sources;

// A single audited correction composes on the immutable native-v2 source seal.
// It does not refresh old hashes or accept any other template change.
export const nullableReadingEvidenceRoot =
  'test/fixtures/reviewed-reading-nullable-successor';
export const nullableReadingProofPaths = [
  `${nullableReadingEvidenceRoot}/manifest.json`,
  `${nullableReadingEvidenceRoot}/community-compose.wxml.before.txt`,
  `${nullableReadingEvidenceRoot}/correction.patch`,
];
function nullablePredecessor(
  file: string,
  current: Buffer,
  readSource: (file: string) => Buffer,
): Buffer {
  if (file !== 'src/pages/community-compose/community-compose.wxml')
    return current;
  const bytes = readSource(nullableReadingProofPaths[0]!);
  assert.equal(
    sha(bytes),
    '74a3f0722d599089f3aa147623a37ccb7c83d8772fa7ddb4ffcaecc62336e3ce',
    'immutable nullable source correction manifest',
  );
  const proof = JSON.parse(bytes.toString('utf8')) as {
    path: string;
    sourceManifestSha256: string;
    nativeV2ManifestSha256: string;
    before: string;
    after: string;
    evidence: string;
    patchSha256: string;
  };
  assert.equal(proof.path, file);
  assert.equal(proof.sourceManifestSha256, manifestHash);
  assert.equal(
    proof.nativeV2ManifestSha256,
    '6f42a9eabca1f43cdec61baf878059bc10a2b173d5c803e382ae980da5b15bba',
  );
  assert.equal(
    proof.before,
    readingSuccessors.find((entry) => entry.path === file)!.after,
    'exact original source-after to nullable-before join',
  );
  assert.equal(proof.evidence, 'community-compose.wxml.before.txt');
  const before = readSource(nullableReadingProofPaths[1]!);
  assert.equal(
    sha(before),
    proof.before,
    'immutable nullable source predecessor',
  );
  assert.equal(
    sha(readSource(nullableReadingProofPaths[2]!)),
    proof.patchSha256,
    'immutable nullable source correction patch',
  );
  assert.equal(sha(current), proof.after, 'exact nullable reading successor');
  let expected = before.toString('utf8');
  const corrections = [
    [
      "{{textSource.format === 'markdown' ? 'tonal' : 'plain'}}",
      "{{textSource &amp;&amp; textSource.format === 'markdown' ? 'tonal' : 'plain'}}",
    ],
    [
      'wx:if="{{textSource.format === \'plain\'}}"',
      'wx:if="{{textSource &amp;&amp; textSource.format === \'plain\'}}"',
    ],
  ] as const;
  for (const [old, next] of corrections) {
    assert.equal(
      expected.split(old).length,
      2,
      'one exact nullable descriptor correction',
    );
    expected = expected.replace(old, next);
  }
  assert.equal(
    current.toString('utf8'),
    expected,
    'only the two explicit nullable source guards may change',
  );
  return before;
}

// One CSS-only formatting edge. Original added-owner hashes and all old proof
// bytes remain authoritative; this is not a general whitespace normalizer.
export const cssReadingEvidenceRoot =
  'test/fixtures/reviewed-reading-css-successor';
export const cssReadingProofPaths = [
  `${cssReadingEvidenceRoot}/manifest.json`,
  `${cssReadingEvidenceRoot}/source-text.wxss.before.txt`,
  `${cssReadingEvidenceRoot}/correction.patch`,
];
function cssPredecessor(
  file: string,
  current: Buffer,
  readSource: (file: string) => Buffer,
): Buffer {
  if (file !== 'src/components/source-text/source-text.wxss') return current;
  const originalHash =
    '695e578ea70d80c0f4a0e25685385fd41dfbd716fd64ee1d31fb8a35ac16e7c9';
  // Unchanged bytes continue through the original added-owner proof directly.
  if (sha(current) === originalHash) return current;
  const bytes = readSource(cssReadingProofPaths[0]!);
  assert.equal(
    sha(bytes),
    '7f4df910a75646408e690171bbfbc5426ddb1ea29978e91c85c441ff271520d6',
    'immutable source CSS whitespace correction manifest',
  );
  const proof = JSON.parse(bytes.toString('utf8')) as {
    path: string;
    sourceManifestSha256: string;
    nativeV4ManifestSha256: string;
    before: string;
    after: string;
    evidence: string;
    patchSha256: string;
  };
  assert.equal(proof.path, file);
  assert.equal(proof.sourceManifestSha256, manifestHash);
  assert.equal(
    proof.nativeV4ManifestSha256,
    '7dfd61b99529d2c123c617f3635e9f5b772068c02d40a2bc0eb57cffbd7afaf2',
  );
  assert.equal(proof.before, originalHash);
  assert.equal(
    proof.before,
    manifest(readSource).added.find((entry) => entry.path === file)!.sha256,
    'exact original added-owner to CSS-before join',
  );
  assert.equal(proof.evidence, 'source-text.wxss.before.txt');
  const before = readSource(cssReadingProofPaths[1]!);
  assert.equal(sha(before), proof.before, 'immutable source CSS predecessor');
  assert.equal(
    sha(readSource(cssReadingProofPaths[2]!)),
    proof.patchSha256,
    'immutable source CSS whitespace patch',
  );
  assert.equal(sha(current), proof.after, 'exact formatted source CSS');
  let expected = before.toString('utf8');
  const rules = [
    ['.source-heading-1', 'font-size: 1.4em;'],
    ['.source-heading-2', 'font-size: 1.25em;'],
    ['.source-heading-3', 'font-size: 1.15em;'],
    ['.source-heading-6', 'font-size: 1em;'],
    ['.source-run-strong', 'font-weight: 600;'],
    ['.source-run-emphasis', 'font-style: italic;'],
    ['.source-toggle::after', 'border: 0;'],
    ['.source-toggle[disabled]', 'opacity: 0.45;'],
    ['.source-unavailable', 'color: var(--wu-secondary-label, #636366);'],
  ] as const;
  for (const [selector, declaration] of rules) {
    const old = `${selector} { ${declaration} }\n`;
    assert.equal(expected.split(old).length, 2, 'one exact CSS rule expansion');
    expected = expected.replace(old, `${selector} {\n  ${declaration}\n}\n`);
  }
  assert.equal(
    current.toString('utf8'),
    expected,
    'only nine exact single-line CSS rules may expand',
  );
  return before;
}

const keyFor = (file: string) =>
  paths.find((key) => file === key || file === `apps/wechat/${key}`);
function authenticate(
  readSource: (file: string) => Buffer,
): Map<string, Buffer> {
  const proof = manifest(readSource),
    before = new Map<string, Buffer>();
  const predecessor = gunzipSync(
    readSource(`${readingEvidenceRoot}/predecessor-manifest.json.gz`),
  );
  assert.equal(
    sha(predecessor),
    predecessorHash,
    'immutable reading predecessor manifest',
  );
  const inventory = (
    JSON.parse(predecessor.toString('utf8')) as {
      files: { path: string; sha256: string; bytes: number }[];
    }
  ).files;
  assert.equal(
    sha(readSource(`${readingEvidenceRoot}/native-source.patch`)),
    proof.patchSha256,
    'immutable reading source delta',
  );
  for (const entry of proof.sources) {
    const rows = inventory.filter(
      (row) => row.path === `apps/wechat/${entry.path}`,
    );
    assert.equal(rows.length, 1, 'unique source predecessor');
    assert.equal(rows[0]!.sha256, entry.before);
    assert.equal(rows[0]!.bytes, entry.beforeBytes);
    assert.equal(entry.evidence, `before/${entry.path}.txt`);
    const bytes = readSource(`${readingEvidenceRoot}/${entry.evidence}`);
    assert.equal(
      sha(bytes),
      entry.before,
      `${entry.path}: immutable reading before bytes`,
    );
    assert.equal(bytes.length, entry.beforeBytes);
    assert.equal(
      sha(nullablePredecessor(entry.path, readSource(entry.path), readSource)),
      entry.after,
      `${entry.path}: exact reading successor`,
    );
    before.set(entry.path, bytes);
  }
  for (const entry of proof.added) {
    assert.ok(
      !inventory.some((row) => row.path === `apps/wechat/${entry.path}`),
    );
    assert.equal(
      sha(cssPredecessor(entry.path, readSource(entry.path), readSource)),
      entry.sha256,
      `${entry.path}: exact added reading owner`,
    );
  }
  return before;
}
/** Exact immediate source-successor admission, not a general historical-hash override. */
export function assertReviewedReadingSuccessor(
  file: string,
  expected: string,
  readSource: (file: string) => Buffer = read,
): boolean {
  const key = keyFor(file),
    entry = readingSuccessors.find((item) => item.path === key);
  if (!entry || expected !== entry.before) return false;
  authenticate(readSource);
  return true;
}
export function readingPredecessor(
  file: string,
  current: Buffer,
  readSource: (file: string) => Buffer = read,
): Buffer {
  const key = keyFor(file);
  if (!key) return current;
  const entry = readingSuccessors.find((item) => item.path === key)!;
  assert.equal(
    sha(nullablePredecessor(key, current, readSource)),
    entry.after,
    `${key}: exact reading presentation successor`,
  );
  const before = authenticate(readSource).get(key)!;
  if (key.endsWith('.wxml'))
    assertReadingActionDelta(
      key,
      before.toString('utf8'),
      current.toString('utf8'),
    );
  return before;
}
const adaptedRead = (readSource: (file: string) => Buffer) => (file: string) =>
  readingPredecessor(file, readSource(file), readSource);
export function assertReviewedReferenceSuccessor(
  file: string,
  expected: string,
  readSource: (file: string) => Buffer = read,
): boolean {
  return originalReference(file, expected, adaptedRead(readSource));
}
/** Two explicit business-after → reading-before joins. The original helper has
 * no injected reader; every other business path continues through it unchanged. */
export function assertReviewedBusinessSuccessor(
  file: string,
  expected: string,
  readSource: (file: string) => Buffer = read,
): boolean {
  const joins = [
    'src/community/contract.ts',
    'src/pages/community-detail/controller.ts',
  ];
  const key = joins.find(
    (candidate) => file === candidate || file === `apps/wechat/${candidate}`,
  );
  if (!key) return originalBusiness(file, expected);
  const originalBytes = read('test/fixtures/business-successor-v33c.json');
  const original = JSON.parse(originalBytes.toString('utf8')) as {
    baselineManifest: string;
    sources: Record<
      string,
      { before: string; after: string; evidence: string; reason: string }
    >;
  };
  const entry = original.sources[key]!;
  if (entry.before !== expected) return false;
  assert.equal(
    sha(readSource('test/reviewed-business-successor.ts')),
    '0899865979024ce96fc723218bd895b1ec660cc906121f1639a7fe3c34f495b8',
    'immutable original business helper',
  );
  assert.equal(
    sha(readSource('test/fixtures/business-successor-v33c.json')),
    '0d5a3671481a36e3bf884d421c6999594eaee8024a99796b0863f1cd6aa4c1ca',
    'immutable original business manifest',
  );
  assert.equal(
    original.baselineManifest,
    '28f996f090a8335506f37cda778692e60cdfb4205bb37e50654f585893084527',
  );
  assert.equal(entry.reason, 'optional-private-discussion-count-contract');
  assert.equal(
    sha(readSource(entry.evidence)),
    expected,
    'immutable original business before bytes',
  );
  assert.equal(
    readingSuccessors.find((item) => item.path === key)!.before,
    entry.after,
    'exact business-after to reading-before join',
  );
  assert.equal(
    sha(readingPredecessor(key, readSource(key), readSource)),
    entry.after,
  );
  return true;
}
const { parsePreviewWxml: parse } = createRequire(__filename)(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const sourceDisabled =
  '{{busy || needsReload || block.busy || block.frozen || report.busy || report.frozen || interaction.busy || interaction.frozen}}';
const threadDisabled =
  '{{busy || needsReload || references.busy || block.busy || block.frozen || report.busy || report.frozen || interaction.busy || interaction.frozen}}';
const condition = (surface: string, detail: boolean) =>
  `{{${surface}.readingBody && ${surface}.readingBody.classification === 'reviewedSource'${detail ? ` && !${surface}.readingUseReferences` : ''}}}`;
const composeAddition = `<view wx:if="{{canChooseTextSource || textSource}}" class="source-options">
<view class="chips" wx:if="{{!frozen}}"><wu-f7-button data-format="plain" bind:press="onSourceFormat" disabled="{{busy}}" variant="{{(!textSource || textSource.format === 'plain') ? 'tonal' : 'plain'}}">纯文字</wu-f7-button><wu-f7-button data-format="markdown" bind:press="onSourceFormat" disabled="{{busy}}" variant="{{textSource &amp;&amp; textSource.format === 'markdown' ? 'tonal' : 'plain'}}">Markdown</wu-f7-button></view>
<view wx:if="{{textSource &amp;&amp; textSource.format === 'plain'}}" class="row"><text>允许长文阅读排版</text><switch checked="{{textSource.readingFormatting === 'auto'}}" bindchange="onReadingFormatting" disabled="{{frozen || busy}}" color="#007aff" /></view>
<view class="notice">{{sourceNotice}}</view><wu-f7-button wx:if="{{textSource}}" bind:press="onSourcePreview" disabled="{{busy}}">{{sourcePreview ? '关闭预览' : '预览原文格式'}}</wu-f7-button><wu-source-text wx:if="{{sourcePreview &amp;&amp; textSource}}" source="{{text}}" descriptor="{{textSource}}" preview="{{true}}" disabled="{{busy}}" /></view>`;
/** Full-tree comparison, not an action-count whitelist. Only exact new siblings
 * at the original text slots and two exact thread buttons are projected away. */
export function assertReadingActionDelta(
  file: string,
  before: string,
  current: string,
): void {
  const detail = file === `${referencePage}.wxml`,
    thread = file === 'src/pages/community-thread/community-thread.wxml',
    compose = file === 'src/pages/community-compose/community-compose.wxml';
  assert.ok(detail || thread || compose, 'explicit reading presentation path');
  const expected = detail
    ? ['item', 'reply', 'post', 'locatedComment']
    : thread
      ? ['reply', 'root']
      : [];
  const seen: string[] = [],
    buttons: string[] = [];
  let options = 0;
  function project(node: PresentationNode): PresentationNode {
    const children: (PresentationNode | string)[] = [];
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      if (typeof child === 'string') {
        children.push(child);
        continue;
      }
      if (compose && child.attrs.class === 'source-options') {
        assert.deepEqual(
          child,
          parse(composeAddition).children[0],
          'exact source authoring controls',
        );
        const previous = node.children[i - 1];
        assert.ok(previous && typeof previous !== 'string');
        assert.equal(previous.attrs.class, 'canvas-counter');
        options++;
        continue;
      }
      if (child.tag === 'wu-source-text') {
        const surface = expected.find(
          (item) =>
            child.attrs.presentation === `{{${item}.readingBody.value}}`,
        );
        assert.ok(
          surface && !seen.includes(surface),
          'one enumerated source surface',
        );
        seen.push(surface);
        assert.deepEqual(child.attrs, {
          'wx:if': condition(surface, detail),
          presentation: `{{${surface}.readingBody.value}}`,
          disabled: sourceDisabled,
        });
        assert.deepEqual(
          child.children,
          [],
          'source renderer remains action-free',
        );
        const fallback = node.children[++i];
        assert.ok(fallback && typeof fallback !== 'string');
        assert.equal(fallback.tag, detail ? 'wu-reference-text' : 'view');
        assert.equal(fallback.attrs['wx:else'], '');
        if (detail) assert.equal(fallback.attrs.source, `{{${surface}.text}}`);
        else assert.deepEqual(fallback.children, [`{{${surface}.text}}`]);
        const attrs = { ...fallback.attrs };
        delete attrs['wx:else'];
        children.push(project({ ...fallback, attrs }));
        continue;
      }
      if (child.attrs.bindtap === 'onSourceThread') {
        assert.ok(detail);
        const surface = ['reply', 'locatedComment'].find(
          (item) => child.attrs['wx:if'] === condition(item, true),
        );
        assert.ok(surface && !buttons.includes(surface));
        buttons.push(surface);
        assert.deepEqual(child.attrs, {
          'wx:if': condition(surface, true),
          class: 'link',
          'data-row-key': `{{'${surface === 'reply' ? 'reply' : 'comment'}:' + ${surface}.id}}`,
          'data-generation': '{{references.generation}}',
          disabled: threadDisabled,
          bindtap: 'onSourceThread',
        });
        assert.deepEqual(child.children, [
          surface === 'reply' ? '查看此条回复' : '打开这条讨论',
        ]);
        const previous = node.children[i - 1];
        assert.ok(
          previous && typeof previous !== 'string' && previous.tag === 'view',
        );
        assert.equal(previous.attrs.class, 'link');
        assert.ok(
          previous.children.some(
            (item) =>
              typeof item !== 'string' &&
              item.tag === 'wu-source-text' &&
              item.attrs.presentation === `{{${surface}.readingBody.value}}`,
          ),
          'thread button stays adjacent to exact current source surface',
        );
        continue;
      }
      children.push(project(child));
    }
    return { ...node, children };
  }
  const projected = project(parse(current));
  assert.deepEqual(seen, expected);
  assert.deepEqual(buttons, detail ? ['reply', 'locatedComment'] : []);
  assert.equal(options, compose ? 1 : 0);
  assert.deepEqual(
    projected,
    parse(before),
    'every original node, binding, text, permission and ancestor remains exact',
  );
}
/** Shared migration entry point: compose new source presentation first, then the
 * original immutable reference proof. Non-source pages are untouched. */
export function reviewedReferencePresentation(
  file: string,
  current: string,
): string {
  const prior = readingPredecessor(file, Buffer.from(current)).toString('utf8');
  if (file !== `${referencePage}.wxml`) return prior;
  const entry = referenceSuccessors.find(
    (item) => item.path === `apps/wechat/${file}`,
  )!;
  assert.equal(
    sha(Buffer.from(prior)),
    entry.after,
    'exact reference-after to reading-before join',
  );
  for (const source of referenceSuccessors)
    assert.equal(
      assertReviewedReferenceSuccessor(source.path, source.before),
      true,
    );
  const original = read(`${referenceEvidenceRoot}/${entry.evidence}`).toString(
    'utf8',
  );
  assertReferenceActionDelta(original, prior);
  return original;
}
