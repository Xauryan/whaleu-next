import type { HotScoreSnapshot } from '../../src/community/hot-score/contracts.js';
import type { HotScoreCertificate } from '../../src/community/hot-score/certificate.js';
import {
  HOT_SCORE_IDENTITY,
  hotScoreCertificateHash,
} from '../../src/community/hot-score/certificate.js';
export const hotFixtureOwner = '22222222-2222-4222-8222-222222222222';
export function hotSnapshot(
  id = '11111111-1111-4111-8111-111111111111',
): HotScoreSnapshot {
  const baseline = {
    postId: id,
    ownerId: hotFixtureOwner,
    sourceRequestId: '33333333-3333-4333-8333-333333333333',
    creationXid: '123',
    createdAt: '2026-10-08T00:00:00Z',
    componentVersion: 1,
    origin: 'native_post_creation',
    openingCounts: ['0'],
    publicationVerified: true,
  } as const;
  const state = {
    postId: id,
    counts: ['0'],
    processedHead: '0',
    capturedHead: '0',
    lastReceiptId: null,
    terminalReceiptValid: true,
    unresolvedSequence: null,
    invalidReceipt: false,
  };
  return structuredClone({
    postId: id,
    ownerId: hotFixtureOwner,
    creationXid: '123',
    snapshotAt: '2026-10-08T01:00:00Z',
    baselines: {
      subscription: { ...baseline, openingCounts: ['0'] },
      like: { ...baseline, openingCounts: ['0'] },
      comment: { ...baseline, openingCounts: ['0', '0', '0', '0'] },
      view: { ...baseline, openingCounts: ['0'] },
    },
    states: {
      subscription: { ...state },
      like: { ...state },
      comment: { ...state, counts: ['0', '0', '0', '0'] },
      view: { postId: id, count: '0' },
    },
  });
}
export function hotCertificate(
  snapshot: HotScoreSnapshot,
  score = '0.0000',
): HotScoreCertificate {
  return {
    post_id: snapshot.postId,
    owner_id: snapshot.ownerId,
    source_request_id: snapshot.baselines.subscription!.sourceRequestId,
    creation_xid: snapshot.creationXid,
    component_version: 1,
    source_formula_version: HOT_SCORE_IDENTITY[0],
    numeric_profile: HOT_SCORE_IDENTITY[1],
    numeric_profile_version: HOT_SCORE_IDENTITY[2],
    formula_fingerprint: HOT_SCORE_IDENTITY[3],
    expression_fingerprint: HOT_SCORE_IDENTITY[4],
    score,
    snapshot: structuredClone(snapshot),
    certificate_hash: hotScoreCertificateHash(snapshot, score),
    clock_matches: true,
  };
}
