import { assertReviewedNoticeExposureSuccessor } from './reviewed-notice-exposure-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
export const noticeEvidenceRoot =
  'test/fixtures/reviewed-notice-read-successor';
const read = (file: string) => readFileSync(path.join(root, file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = read(`${noticeEvidenceRoot}/manifest.json`);
assert.equal(
  sha(manifestBytes),
  'ce365ec5df64fd0e9893d4a36dda54e342b3452982944cd943224d13861b3372',
);
export const noticeSuccessors = (
  JSON.parse(manifestBytes.toString('utf8')) as {
    reviewedDeltaSha256: string;
    sources: Record<
      string,
      { before: string; after: string; evidence: string }
    >;
  }
).sources;
const paths = [
  'src/pages/rating-discussion-media/rating-discussion-media.wxml',
  'src/pages/rating-scoped/rating-scoped.wxml',
  'src/ratings/discussion-controller.ts',
  'src/ratings/discussion-media-page-controller.ts',
  'src/ratings/discussion-media-page.ts',
  'src/ratings/scoped-controller.ts',
  'src/ratings/scoped-page.ts',
  'src/ratings/updates-controller.ts',
];
assert.deepEqual(Object.keys(noticeSuccessors).sort(), paths.sort());

/** Exact reviewed transition only. Original inventories and predecessor bytes stay immutable. */
export function assertReviewedNoticeReadSuccessor(
  file: string,
  expected: string,
  readSource: (file: string) => Buffer = read,
): boolean {
  const key = paths.find(
    (candidate) =>
      file === candidate ||
      file === `apps/wechat/${candidate}` ||
      file === candidate.slice(4),
  );
  if (!key) return false;
  const entry = noticeSuccessors[key]!;
  if (entry.before !== expected) return false;
  assert.equal(entry.evidence, `${noticeEvidenceRoot}/${key}.txt`);
  assert.equal(
    sha(readSource(entry.evidence)),
    expected,
    `${key}: immutable explicit-read predecessor`,
  );
  if (assertReviewedNoticeExposureSuccessor(key, entry.after, readSource))
    return true;
  assert.equal(
    sha(readSource(key)),
    entry.after,
    `${key}: exact reviewed explicit-read successor`,
  );
  return true;
}

/** Historical presentation comparisons run on authenticated predecessor bytes;
 * separate successor tests compare every original live action plus exactly two
 * reviewed new controls, including all ancestor gates. Unknown files stay live. */
export function reviewedNoticePresentation(
  file: string,
  current: string,
): string {
  if (!paths.slice(0, 2).includes(file)) return current;
  const entry = noticeSuccessors[file]!;
  assert.equal(
    sha(Buffer.from(current)),
    entry.after,
    `${file}: exact reviewed presentation successor`,
  );
  assertReviewedNoticeReadSuccessor(file, entry.before);
  return read(entry.evidence).toString('utf8');
}

/** Retain the intermediate social revision for its original structural proof. */
export function reviewedNoticePredecessor(
  file: string,
  expected: string,
): Buffer {
  assert.equal(assertReviewedNoticeReadSuccessor(file, expected), true);
  return read(noticeSuccessors[file]!.evidence);
}
