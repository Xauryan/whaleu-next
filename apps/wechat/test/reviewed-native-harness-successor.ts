import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
const originalSha =
  'f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05';
const currentSha =
  'a853e7bdd808a40158356dc05e78ced791ee2b5682bd2d433c411aa87117bed0';
const parserSha =
  '7cc376ea0a7e2fa6efea3c1fc3d377255284f0ffb2754a01939f5e2efb87b32b';
const parserSuccessorSha =
  'df81246ef3388a69e04b6faaf6e6294c57ecfe92b2090e4e9f85132b5dd5c0d1';
const parserSuccessorManifestSha =
  'aee93b8d532555354429fb62b39acaf65d9a59b53ab295760e1c8ff138965e3d';
const manifestSha =
  '3fd1561c7a3e94bb8c0ff68a081178edefb60d9b5b30eb05cbf081e4b1f22ec4';
const lineageSha =
  'ac508cd3f905d62adefcdc89eb85accd822f4557eeb857d37b69f84b6f6609f2';
const hash = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
export interface NativeHarnessEvidence {
  manifest: Buffer;
  original: Buffer;
  current: Buffer;
  parser: Buffer;
  parserOriginal: Buffer;
  parserSuccessorManifest: Buffer;
  originalApproval: Buffer;
}
/** Only this one audited test harness and its exact original hash may advance.
 * No runtime, component, controller, arbitrary path, or stale hash is allowed.
 * Historical harness approvals and original parser bytes remain independently
 * pinned. Only the exact reviewed attribute decoder successor may advance.
 */
export function verifyReviewedNativeHarnessSuccessor(
  file: string,
  expected: string,
  evidence: NativeHarnessEvidence,
): boolean {
  if (
    ![
      'test/native-press-emitted-harness.mjs',
      'apps/wechat/test/native-press-emitted-harness.mjs',
    ].includes(file) ||
    expected !== originalSha
  )
    return false;
  assert.equal(
    hash(evidence.manifest),
    manifestSha,
    'reviewed harness provenance and lineage',
  );
  assert.equal(
    hash(evidence.originalApproval),
    lineageSha,
    'immutable original 085e to f271 approval',
  );
  assert.equal(
    hash(evidence.original),
    originalSha,
    'immutable f271 harness evidence',
  );
  assert.equal(
    hash(evidence.current),
    currentSha,
    'exact reviewed native harness successor',
  );
  assert.equal(
    hash(evidence.parserOriginal),
    parserSha,
    'immutable original single text decoder boundary',
  );
  assert.equal(
    hash(evidence.parserSuccessorManifest),
    parserSuccessorManifestSha,
    'reviewed attribute decoder provenance',
  );
  assert.equal(
    hash(evidence.parser),
    parserSuccessorSha,
    'exact reviewed single-pass attribute decoder successor',
  );
  return true;
}
export function assertReviewedNativeHarnessSuccessor(
  file: string,
  expected: string,
): boolean {
  if (
    ![
      'test/native-press-emitted-harness.mjs',
      'apps/wechat/test/native-press-emitted-harness.mjs',
    ].includes(file) ||
    expected !== originalSha
  )
    return false;
  const read = (file: string) => readFileSync(path.join(root, file));
  return verifyReviewedNativeHarnessSuccessor(file, expected, {
    manifest: read('test/fixtures/native-harness-successor-v38.json'),
    original: read('test/fixtures/native-harness-original-f271.mjs.txt'),
    current: read('test/native-press-emitted-harness.mjs'),
    parser: read('scripts/smoke-ratings.mjs'),
    parserOriginal: read(
      'test/fixtures/native-renderer-original-7cc376ea.mjs.txt',
    ),
    parserSuccessorManifest: read(
      'test/fixtures/native-renderer-attribute-successor-v38h6.json',
    ),
    originalApproval: read(
      'test/fixtures/framework7-activities-reviewed-shared.json',
    ),
  });
}
