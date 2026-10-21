import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import type { PresentationNode } from './framework7-action-parity';

const root = path.join(__dirname, '..');
export const referenceEvidenceRoot =
  'test/fixtures/reviewed-reference-successor';
export const referencePage = 'src/pages/community-detail/community-detail';
const read = (file: string) => readFileSync(path.join(root, file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifestHash =
  'b0bad6e8817cffc9d2c4d9c8a0f45e45526fdfc18f55008b3b4d6e0562e29f14';
const predecessorHash =
  '7c42b101696a505131bd1e2de6b1ee629d0b30b1c4b160f347a6a011dd4940c7';
const paths = ['ts', 'wxml', 'json'].map((ext) => `${referencePage}.${ext}`);
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
interface Source {
  path: string;
  before: string;
  after: string;
  evidence: string;
}
interface Manifest {
  predecessorManifestSha256: string;
  sources: Source[];
  actions: {
    beforeCount: number;
    afterCount: number;
    unchangedCount: number;
    removed: Action[];
    added: Action[];
  };
}
function authenticatedManifest(
  readSource: (file: string) => Buffer = read,
): Manifest {
  const bytes = readSource(`${referenceEvidenceRoot}/manifest.json`);
  assert.equal(
    sha(bytes),
    manifestHash,
    'immutable reference successor manifest',
  );
  const manifest = JSON.parse(bytes.toString('utf8')) as Manifest;
  assert.equal(manifest.predecessorManifestSha256, predecessorHash);
  assert.deepEqual(
    manifest.sources.map((entry) => entry.path).sort(),
    paths.map((file) => `apps/wechat/${file}`).sort(),
  );
  return manifest;
}
const manifest = authenticatedManifest();
export const referenceSuccessors = manifest.sources;

/** Only explicit inventory aliases are allowed; arbitrary path normalization is not. */
export function assertReviewedReferenceSuccessor(
  file: string,
  expected: string,
  readSource: (file: string) => Buffer = read,
): boolean {
  const key = paths.find(
    (candidate) => file === candidate || file === `apps/wechat/${candidate}`,
  );
  if (!key) return false;
  const entry = referenceSuccessors.find(
    (source) => source.path === `apps/wechat/${key}`,
  )!;
  if (entry.before !== expected) return false;
  authenticatedManifest(readSource);
  // Preserve the complete, original V35B manifest rather than manufacturing a
  // new baseline from live bytes. Compression changes storage, not evidence.
  const predecessor = gunzipSync(
    readSource(`${referenceEvidenceRoot}/predecessor-manifest.json.gz`),
  );
  assert.equal(
    sha(predecessor),
    predecessorHash,
    'immutable V35B predecessor manifest',
  );
  const inventory = JSON.parse(predecessor.toString('utf8')) as {
    path: string;
    sha256: string;
    bytes: number;
  }[];
  const rows = inventory.filter((row) => row.path === entry.path);
  assert.equal(rows.length, 1, `${key}: unique authenticated predecessor`);
  assert.equal(rows[0]!.sha256, expected);
  assert.equal(entry.evidence, `before/${path.basename(key)}.txt`);
  const evidence = readSource(`${referenceEvidenceRoot}/${entry.evidence}`);
  assert.equal(evidence.length, rows[0]!.bytes);
  assert.equal(
    sha(evidence),
    expected,
    `${key}: immutable reference predecessor`,
  );
  assert.equal(
    sha(readSource(key)),
    entry.after,
    `${key}: exact reviewed reference successor`,
  );
  return true;
}

interface Ancestor {
  tag: string;
  attrs: Record<string, string>;
}
interface LocatedNode {
  node: PresentationNode;
  ancestors: Ancestor[];
  scopes: Record<string, string>[];
}
function locate(
  node: PresentationNode,
  ancestors: Ancestor[] = [],
  parents: Record<string, string>[] = [],
): LocatedNode[] {
  const own = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) =>
      [
        'wx:if',
        'wx:elif',
        'wx:else',
        'wx:for',
        'wx:for-item',
        'wx:for-index',
        'wx:key',
        'hidden',
      ].includes(key),
    ),
  );
  const scopes = Object.keys(own).length ? [...parents, own] : parents;
  return [
    { node, ancestors, scopes },
    ...node.children.flatMap((child) =>
      typeof child === 'string'
        ? []
        : locate(
            child,
            [...ancestors, { tag: node.tag, attrs: node.attrs }],
            scopes,
          ),
    ),
  ];
}
const isAction = ({ node }: LocatedNode) =>
  node.tag === 'navigator' ||
  node.tag === 'wu-reference-text' ||
  Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key));
const action = ({ node, scopes }: LocatedNode): Action => ({
  tag: node.tag,
  attrs: node.attrs,
  scopes,
});
const rawAction = (located: LocatedNode) => ({
  ...action(located),
  ancestors: located.ancestors,
});
const { parsePreviewWxml: parse } = createRequire(__filename)(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };

/** No blanket component exclusion: prove 143 exact raw actions and all ancestors,
 * then admit only four specified renderers at their original text positions. */
export function assertReferenceActionDelta(
  before: string,
  after: string,
): void {
  const oldNodes = locate(parse(before)),
    newNodes = locate(parse(after));
  const oldActions = oldNodes.filter(isAction),
    newActions = newNodes.filter(isAction);
  assert.equal(oldActions.length, 145);
  assert.equal(newActions.length, 147);
  assert.equal(manifest.actions.beforeCount, 145);
  assert.equal(manifest.actions.afterCount, 147);
  assert.equal(manifest.actions.unchangedCount, 143);
  const removed = oldActions.filter((located) =>
    manifest.actions.removed.some((entry) =>
      isDeepStrictEqual(action(located), entry),
    ),
  );
  assert.deepEqual(removed.map(action), manifest.actions.removed);
  assert.equal(removed.length, 2);
  const added = newNodes.filter(({ node }) => node.tag === 'wu-reference-text');
  assert.equal(added.length, 4);
  assert.deepEqual(added.map(action), manifest.actions.added);
  const retainedBefore = oldActions.filter(
    (located) => !removed.includes(located),
  );
  const retainedAfter = newActions.filter(
    (located) => !added.includes(located),
  );
  assert.equal(retainedBefore.length, 143);
  assert.equal(retainedAfter.length, 143);
  assert.deepEqual(
    retainedAfter.map(rawAction),
    retainedBefore.map(rawAction),
    'all original raw attributes and full ancestor chains remain exact',
  );

  for (const component of added) {
    const source = component.node.attrs.source!;
    const fallback =
      source === '{{reply.text}}' || source === '{{locatedComment.text}}';
    const original = fallback
      ? removed.filter(({ node }) =>
          node.children.some(
            (child) =>
              typeof child === 'string' &&
              child.includes(source.slice(0, -2) + " || '查看图片回复'}}"),
          ),
        )
      : oldNodes.filter(({ node }) =>
          node.children.some(
            (child) => typeof child === 'string' && child.trim() === source,
          ),
        );
    assert.equal(
      original.length,
      1,
      `${source}: unique predecessor text location`,
    );
    const previous = original[0]!;
    const expectedAncestors = fallback
      ? [...previous.ancestors, { tag: 'view', attrs: { class: 'link' } }]
      : source === '{{item.text}}'
        ? [
            ...previous.ancestors,
            { tag: previous.node.tag, attrs: previous.node.attrs },
          ]
        : previous.ancestors;
    assert.deepEqual(
      component.ancestors,
      expectedAncestors,
      `${source}: original full ancestor gates`,
    );
    assert.deepEqual(
      component.node.children,
      fallback
        ? previous.node.children.filter((child) => typeof child !== 'string')
        : [],
      `${source}: original fallback icon, no nested action`,
    );
  }
}

/** Old migration inventories still inspect authenticated original actions. Live
 * successors must first pass the exact three-file seal and the explicit delta. */
export function reviewedReferencePresentation(
  file: string,
  current: string,
): string {
  if (file !== `${referencePage}.wxml`) return current;
  const entry = referenceSuccessors.find(
    (source) => source.path === `apps/wechat/${file}`,
  )!;
  assert.equal(
    sha(Buffer.from(current)),
    entry.after,
    `${file}: exact reviewed presentation successor`,
  );
  for (const source of referenceSuccessors)
    assert.equal(
      assertReviewedReferenceSuccessor(source.path, source.before),
      true,
    );
  const predecessor = read(
    `${referenceEvidenceRoot}/${entry.evidence}`,
  ).toString('utf8');
  assertReferenceActionDelta(predecessor, current);
  return predecessor;
}
