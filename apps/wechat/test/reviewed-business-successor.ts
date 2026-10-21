import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const root = path.join(__dirname, '..');
const manifest = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/business-successor-v33c.json'),
    'utf8',
  ),
) as {
  baselineManifest: string;
  sources: Record<
    string,
    { before: string; after: string; evidence: string; reason: string }
  >;
};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/**
 * Historical migration inventories stay immutable. Only six explicitly reviewed
 * later business successors are accepted, and both the saved original bytes and
 * the current exact successor are independently checked before an old assertion
 * is superseded. Unknown files/hashes still use their original strict guard.
 * Behavior/layout regressions live in optional-discussion-counts.test.ts and the
 * private timetable tests. This is not a wildcard or automatic hash refresh.
 */
export function assertReviewedBusinessSuccessor(
  file: string,
  expected: string,
): boolean {
  const key = file.startsWith('apps/wechat/')
    ? file.slice('apps/wechat/'.length)
    : file;
  assert.deepEqual(
    Object.keys(manifest.sources).sort(),
    [
      'src/app.json',
      'src/community/contract.ts',
      'src/pages/community-feed/community-feed.wxml',
      'src/pages/community-detail/controller.ts',
      'src/post-pins/feed.wxml',
      'src/pages/feedback/feedback.wxml',
    ].sort(),
  );
  const entry = manifest.sources[key];
  if (!entry || entry.before !== expected) return false;
  assert.equal(
    manifest.baselineManifest,
    '28f996f090a8335506f37cda778692e60cdfb4205bb37e50654f585893084527',
  );
  assert.equal(
    sha(readFileSync(path.join(root, entry.evidence))),
    expected,
    `${key}: immutable V33C evidence`,
  );
  assert.equal(
    sha(readFileSync(path.join(root, key))),
    entry.after,
    `${key}: reviewed business successor`,
  );
  assert.ok(
    [
      'manual-timetable-route-registration',
      'optional-private-discussion-count-contract',
    ].includes(entry.reason),
  );
  return true;
}
