import { assertReviewedNoticeExposureSuccessor } from './reviewed-notice-exposure-successor';
import { assertReviewedNoticeReadSuccessor } from './reviewed-notice-read-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
const evidenceRoot = 'test/fixtures/reviewed-social-successor-v33c';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const read = (file: string) => readFileSync(path.join(root, file));
const manifestBytes = read(`${evidenceRoot}/manifest.json`);
assert.equal(
  sha(manifestBytes),
  '6396a37239db04dade540b86620cb975e951ff89c75cc0b6e8c40d82ca245926',
  'The reviewed social successor manifest is immutable, not a hash refresh',
);
const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
  baselineManifest: string;
  reviewedNativeManifest: string;
  sources: Record<
    string,
    { before: string; after: string; evidence: string; reason: string }
  >;
};
const reviewedPaths = [
  'src/ratings/discussion-controller.ts',
  'src/pages/social-notices/controller.ts',
  'src/pages/social-notices/social-notices.ts',
] as const;

/**
 * A later reviewed business slice, not a presentation-only baseline rewrite.
 * Only the three exact paths below (and their explicit inventory aliases) can
 * supersede an old guard. Both immutable V33C evidence and exact reviewed live
 * bytes must match. Unknown paths/hashes still reach the original assertion.
 * The optional reader is solely a test seam for rejecting corrupted evidence
 * without editing production files; historical guards always use the default.
 */
export function assertReviewedSocialSuccessor(
  file: string,
  expected: string,
  readSource: (file: string) => Buffer = read,
): boolean {
  // Do not normalize, resolve, strip arbitrary prefixes, or accept wildcards.
  const key = reviewedPaths.find(
    (candidate) =>
      file === candidate ||
      file === `apps/wechat/${candidate}` ||
      file === candidate.slice('src/'.length),
  );
  if (!key) return false;
  assert.deepEqual(
    Object.keys(manifest.sources).sort(),
    [...reviewedPaths].sort(),
  );
  const entry = manifest.sources[key]!;
  if (entry.before !== expected) return false;
  assert.equal(
    manifest.baselineManifest,
    '28f996f090a8335506f37cda778692e60cdfb4205bb37e50654f585893084527',
  );
  assert.equal(
    manifest.reviewedNativeManifest,
    'f822d3376e70485e7e6d9040d41fd6de24f7475c64af8bb03ac25e64a82745f4',
  );
  assert.equal(entry.evidence, `${evidenceRoot}/${key}.txt`);
  assert.equal(
    sha(readSource(entry.evidence)),
    expected,
    `${key}: immutable V33C evidence`,
  );
  if (assertReviewedNoticeReadSuccessor(key, entry.after, readSource))
    return true;
  if (assertReviewedNoticeExposureSuccessor(key, entry.after, readSource))
    return true;
  assert.equal(
    sha(readSource(key)),
    entry.after,
    `${key}: exact reviewed social business successor`,
  );
  return true;
}
