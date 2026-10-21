import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const exposureInventoryPath =
  '../../docs/NOTICE_EXPOSURE_READ_INVENTORY.json';
export const exposureDeltaPath = '../../docs/NOTICE_EXPOSURE_READ_DELTA.patch';
export const exposureEvidenceRoot = 'test/fixtures/notice-exposure-before';
const inventoryHash =
  '2af3ead32dddeef4569d621f6007f6367eff778332fe9b38887189f77712bcd8';
const deltaHash =
  'daff467367f8810e0e445edbc80f2ad1fea7d6d05f33fb92961a41faebfaf05f';
const correctionInventoryPath =
  '../../docs/NOTICE_EXPOSURE_UNCERTAIN_READ_CORRECTION.json';
const correctionDeltaPath =
  '../../docs/NOTICE_EXPOSURE_UNCERTAIN_READ_CORRECTION.patch';
const correctionInventoryHash =
  'ffe95b91f8214a71b8a4ff1315a28be4f055ac0102cafe2415ce7f1b09291f26';
const correctionDeltaHash =
  '2711b8c7b0f13666dc91926176e2c74e96fdf5ddced2ecf0c445499b8f2eabf2';
const correctionEvidence = {
  'src/ratings/updates-controller.ts':
    'test/fixtures/notice-exposure-uncertain-before/ratings-updates-controller.ts.txt',
  'src/notifications/student-notices.ts':
    'test/fixtures/notice-exposure-uncertain-before/student-notices.ts.txt',
};
const correctionPaths = Object.keys(
  correctionEvidence,
) as (keyof typeof correctionEvidence)[];
const changedPaths = [
  'src/notifications/social-updates/controller.ts',
  'src/pages/community-updates/controller.ts',
  'src/ratings/updates-controller.ts',
  'src/window-discussion/notices-controller.ts',
  'src/major-discussion/notices-controller.ts',
  'src/pages/system-notices/controller.ts',
  'src/errands/notices.ts',
  'src/pages/feedback-notices/controller.ts',
  'src/notifications/student-notices.ts',
  'src/pages/social-notices/controller.ts',
  'src/notifications/system-timeline.ts',
  'src/pages/social-notices/social-notices.ts',
  'src/pages/social-notices/social-notices.wxml',
  'src/pages/system-notices/system-notices.ts',
  'src/pages/system-notices/system-notices.wxml',
] as const;
const addedPaths = [
  'src/notifications/notice-exposure.ts',
  'src/notifications/notice-read-guard.ts',
] as const;
interface ExposureManifest {
  changed: Record<string, { before: string; after: string; evidence: string }>;
  added: Record<string, string>;
}
export const exposureSuccessors = (
  JSON.parse(read(exposureInventoryPath).toString('utf8')) as ExposureManifest
).changed;
const evidencePath = (file: string) =>
  `${exposureEvidenceRoot}/${
    /\/(social-notices|system-notices)\.(ts|wxml)$/.test(file)
      ? path.basename(file)
      : file
  }.txt`;
export const exposureProofPaths = [
  exposureInventoryPath,
  exposureDeltaPath,
  correctionInventoryPath,
  correctionDeltaPath,
  ...correctionPaths.flatMap((file) => [correctionEvidence[file], file]),
  ...changedPaths.flatMap((file) => [
    evidencePath(file),
    ...(correctionPaths.some((key) => key === file) ? [] : [file]),
  ]),
  ...addedPaths,
];

/** This later business correction is not part of optional-guard AST equivalence.
 * Authenticate its exact two intermediate revisions and corrected live outputs,
 * then join those intermediates to the unchanged original exposure inventory. */
function authenticatedCorrections(
  original: ExposureManifest,
  readSource: (file: string) => Buffer,
): Map<string, Buffer> {
  const bytes = readSource(correctionInventoryPath);
  assert.equal(
    sha(bytes),
    correctionInventoryHash,
    'immutable exposure uncertainty correction inventory',
  );
  const correction = JSON.parse(bytes.toString('utf8')) as Pick<
    ExposureManifest,
    'changed'
  > & {
    predecessorInventory: { path: string; sha256: string };
    delta: { path: string; sha256: string };
  };
  assert.deepEqual(correction.predecessorInventory, {
    path: 'docs/NOTICE_EXPOSURE_READ_INVENTORY.json',
    sha256: inventoryHash,
  });
  assert.deepEqual(correction.delta, {
    path: 'docs/NOTICE_EXPOSURE_UNCERTAIN_READ_CORRECTION.patch',
    sha256: correctionDeltaHash,
  });
  assert.deepEqual(
    Object.keys(correction.changed).sort(),
    [...correctionPaths].sort(),
  );
  assert.equal(
    sha(readSource(correctionDeltaPath)),
    correctionDeltaHash,
    'immutable exposure uncertainty correction delta',
  );
  const intermediates = new Map<string, Buffer>();
  for (const file of correctionPaths) {
    const entry = correction.changed[file]!;
    assert.equal(
      entry.before,
      original.changed[file]!.after,
      `${file}: exact exposure-to-correction join`,
    );
    assert.equal(entry.evidence, correctionEvidence[file]);
    const before = readSource(entry.evidence);
    assert.equal(
      sha(before),
      entry.before,
      `${file}: immutable exposure correction predecessor`,
    );
    assert.equal(
      sha(readSource(file)),
      entry.after,
      `${file}: exact reviewed exposure successor (uncertainty correction)`,
    );
    intermediates.set(file, before);
  }
  return intermediates;
}
function authenticateSlice(readSource: (file: string) => Buffer): void {
  const bytes = readSource(exposureInventoryPath);
  assert.equal(sha(bytes), inventoryHash, 'immutable exposure inventory');
  const manifest = JSON.parse(bytes.toString('utf8')) as ExposureManifest;
  assert.deepEqual(
    Object.keys(manifest.changed).sort(),
    [...changedPaths].sort(),
  );
  assert.deepEqual(Object.keys(manifest.added).sort(), [...addedPaths].sort());
  assert.deepEqual(manifest.changed, exposureSuccessors);
  assert.equal(
    sha(readSource(exposureDeltaPath)),
    deltaHash,
    'immutable exposure delta',
  );
  const intermediates = authenticatedCorrections(manifest, readSource);
  // A changed controller is not independently safe if either shared guard or
  // actual Page changes later. Authenticate the entire bounded slice each time.
  for (const file of changedPaths) {
    const entry = manifest.changed[file]!;
    assert.equal(entry.evidence, evidencePath(file));
    assert.equal(
      sha(readSource(entry.evidence)),
      entry.before,
      `${file}: immutable exposure predecessor`,
    );
    assert.equal(
      sha(intermediates.get(file) ?? readSource(file)),
      entry.after,
      `${file}: exact reviewed exposure successor`,
    );
  }
  for (const file of addedPaths)
    assert.equal(
      sha(readSource(file)),
      manifest.added[file],
      `${file}: exact reviewed exposure dependency`,
    );
}

/** Only these exact fifteen transitions, with all seventeen live sources and
 * immutable predecessor/intermediate evidence authenticated, including the separately
 * reviewed two-source uncertainty correction. Never normalize unknown paths,
 * refresh an older inventory, strip guards, or accept a merely current hash. */
export function assertReviewedNoticeExposureSuccessor(
  file: string,
  expected: string,
  readSource: (file: string) => Buffer = read,
): boolean {
  const key = changedPaths.find(
    (candidate) =>
      file === candidate ||
      file === `apps/wechat/${candidate}` ||
      file === candidate.slice(4),
  );
  if (!key || exposureSuccessors[key]!.before !== expected) return false;
  authenticateSlice(readSource);
  return true;
}

/** Earlier structural proofs must still run on their exact reviewed revision;
 * exposure action/AST and actual Page transport tests separately exercise live bytes. */
export function reviewedExposurePredecessor(
  file: string,
  expected: string,
): Buffer {
  assert.equal(assertReviewedNoticeExposureSuccessor(file, expected), true);
  const bytes = read(exposureSuccessors[file]!.evidence);
  assert.equal(sha(bytes), expected, `${file}: immutable exposure predecessor`);
  return bytes;
}
