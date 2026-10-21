import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (file: string) => readFileSync(path.join(__dirname, '..', file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const runtimeIdentityEvidenceRoot =
  'test/fixtures/reviewed-reading-runtime-identity-successor';
export const runtimeIdentityPaths = [
  'src/api/client.ts',
  'src/community/reading-gateway.ts',
  'src/pages/community-detail/community-detail.ts',
  'src/pages/community-detail/controller.ts',
  'src/pages/community-thread/community-thread.ts',
  'src/pages/community-thread/controller.ts',
];
interface Source {
  path: string;
  before: string;
  after: string;
  beforeBytes: number;
  afterBytes: number;
  evidence: string;
  gitBlob: string;
}
interface Manifest {
  predecessorCommit: string;
  readingManifestSha256: string;
  sources: Source[];
  patchSha256: string;
}
function manifest(readSource: (file: string) => Buffer): Manifest {
  const bytes = readSource(`${runtimeIdentityEvidenceRoot}/manifest.json`);
  assert.equal(
    sha(bytes),
    'fd80fd721fba749b527ec7d65d3947401364915ea193475a8dd24cd2a812b92d',
    'immutable runtime identity successor manifest',
  );
  const proof = JSON.parse(bytes.toString('utf8')) as Manifest;
  assert.equal(
    proof.predecessorCommit,
    'b53198d394546c2e07c51440169a63db45cf164d',
  );
  assert.deepEqual(
    proof.sources.map((entry) => entry.path),
    runtimeIdentityPaths,
  );
  return proof;
}
export const runtimeIdentitySuccessors = manifest(read).sources;
export const runtimeIdentityProofPaths = [
  `${runtimeIdentityEvidenceRoot}/manifest.json`,
  `${runtimeIdentityEvidenceRoot}/correction.patch`,
  ...runtimeIdentitySuccessors.map(
    (entry) => `${runtimeIdentityEvidenceRoot}/${entry.evidence}`,
  ),
];

/** Authenticate the entire six-owner snapshot, not just the requested file.
 * In particular, the API guard must never be omitted from the reading proof.
 * This admits one exact successor only; old or mixed snapshots are not accepted.
 */
export function runtimeIdentityPredecessor(
  file: string,
  current: Buffer,
  readSource: (file: string) => Buffer = read,
): Buffer {
  const key = runtimeIdentityPaths.find(
    (candidate) => file === candidate || file === `apps/wechat/${candidate}`,
  );
  if (!key) return current;
  const proof = manifest(readSource);
  const readingBytes = readSource(
    'test/fixtures/reviewed-reading-successor/manifest.json',
  );
  assert.equal(
    sha(readingBytes),
    proof.readingManifestSha256,
    'immutable original reading seal',
  );
  const reading = JSON.parse(readingBytes.toString('utf8')) as {
    sources: { path: string; after: string }[];
    added: { path: string; sha256: string }[];
  };
  assert.equal(
    sha(readSource(`${runtimeIdentityEvidenceRoot}/correction.patch`)),
    proof.patchSha256,
    'immutable runtime identity patch',
  );
  const predecessors = new Map<string, Buffer>();
  for (const entry of proof.sources) {
    assert.equal(entry.evidence, `before/${entry.path}.txt`);
    const before = readSource(
      `${runtimeIdentityEvidenceRoot}/${entry.evidence}`,
    );
    assert.equal(
      sha(before),
      entry.before,
      `${entry.path}: exact b531 predecessor`,
    );
    assert.equal(before.length, entry.beforeBytes);
    assert.equal(
      createHash('sha1')
        .update(`blob ${before.length}\0`)
        .update(before)
        .digest('hex'),
      entry.gitBlob,
      `${entry.path}: exact predecessor Git blob`,
    );
    if (entry.path !== 'src/api/client.ts') {
      const oldHash =
        reading.sources.find((source) => source.path === entry.path)?.after ??
        reading.added.find((source) => source.path === entry.path)?.sha256;
      assert.equal(
        entry.before,
        oldHash,
        `${entry.path}: exact original reading-after join`,
      );
    }
    const live = readSource(entry.path);
    assert.equal(
      sha(live),
      entry.after,
      `${entry.path}: exact runtime identity successor`,
    );
    assert.equal(live.length, entry.afterBytes);
    predecessors.set(entry.path, before);
  }
  assert.equal(
    sha(current),
    proof.sources.find((entry) => entry.path === key)!.after,
    `${key}: exact supplied runtime identity successor`,
  );
  return predecessors.get(key)!;
}
