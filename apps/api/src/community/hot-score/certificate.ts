import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HOT_SCORE_COMPONENTS, validateHotScoreSnapshot } from './contracts.js';
import type { HotScoreSnapshot } from './contracts.js';
import {
  HOT_SCORE_FORMULA,
  HOT_SCORE_FORMULA_FINGERPRINT,
  HOT_SCORE_NUMERIC_PROFILE,
  HOT_SCORE_NUMERIC_PROFILE_VERSION,
  HOT_SCORE_EXPRESSION_FINGERPRINT,
} from './formula.js';

export const hotScoreDecimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})\.[0-9]{4}$/);
export const HOT_SCORE_IDENTITY = Object.freeze([
  HOT_SCORE_FORMULA.sourceFormulaVersion,
  HOT_SCORE_NUMERIC_PROFILE,
  HOT_SCORE_NUMERIC_PROFILE_VERSION,
  HOT_SCORE_FORMULA_FINGERPRINT,
  HOT_SCORE_EXPRESSION_FINGERPRINT,
] as const);

/** Fixed positional encoding avoids JSONB object-key ordering and never rounds a
 * bigint/decimal through Number. snapshotAt is the certificate creation clock;
 * it is deliberately excluded from currency, but included in the stored hash. */
export function hotScoreVector(snapshot: HotScoreSnapshot): string {
  const ready = validateHotScoreSnapshot(snapshot);
  if (ready.status !== 'ready')
    throw new Error('Score certificate is not ready');
  const value = ready.snapshot;
  return JSON.stringify([
    value.postId,
    value.ownerId,
    value.creationXid,
    HOT_SCORE_COMPONENTS.map((component) => {
      const b = value.baselines[component]!;
      return [
        b.postId,
        b.componentVersion,
        b.origin,
        b.ownerId,
        b.sourceRequestId,
        b.creationXid,
        b.createdAt,
        b.openingCounts,
        b.publicationVerified,
      ];
    }),
    (['subscription', 'like', 'comment'] as const).map((component) => {
      const s = value.states[component]!;
      return [
        s.postId,
        s.counts,
        s.processedHead,
        s.capturedHead,
        s.lastReceiptId,
        s.terminalReceiptValid,
        s.unresolvedSequence,
        s.invalidReceipt,
      ];
    }),
    [value.states.view!.postId, value.states.view!.count],
  ]);
}
export function hotScoreCertificateHash(
  snapshot: HotScoreSnapshot,
  score: string,
): string {
  hotScoreDecimalSchema.parse(score);
  return createHash('sha256')
    .update(
      JSON.stringify([
        'whaleu-hot-certificate',
        1,
        HOT_SCORE_IDENTITY,
        hotScoreVector(snapshot),
        score,
        snapshot.snapshotAt,
      ]),
    )
    .digest('hex');
}
export interface HotScoreCertificate {
  post_id: string;
  owner_id: string;
  source_request_id: string;
  creation_xid: string;
  component_version: number;
  source_formula_version: number;
  numeric_profile: string;
  numeric_profile_version: number;
  formula_fingerprint: string;
  expression_fingerprint: string;
  score: string;
  snapshot: HotScoreSnapshot;
  certificate_hash: string;
  clock_matches: boolean;
}
/** The certificate attests previously validated immutable receipt history. We
 * still rerun the complete retained-source/receipt validator on every selected
 * public candidate: this does not infer currency from heads or timestamps. The
 * database/access-control owner is trusted for stored arithmetic, like views. */
export function currentHotScoreCertificate(
  certificate: HotScoreCertificate,
  snapshot: HotScoreSnapshot,
): boolean {
  try {
    return (
      certificate.post_id === snapshot.postId &&
      certificate.owner_id === snapshot.ownerId &&
      certificate.source_request_id ===
        snapshot.baselines.subscription?.sourceRequestId &&
      certificate.creation_xid === snapshot.creationXid &&
      certificate.component_version === 1 &&
      JSON.stringify([
        certificate.source_formula_version,
        certificate.numeric_profile,
        certificate.numeric_profile_version,
        certificate.formula_fingerprint,
        certificate.expression_fingerprint,
      ]) === JSON.stringify(HOT_SCORE_IDENTITY) &&
      certificate.clock_matches === true &&
      hotScoreVector(certificate.snapshot) === hotScoreVector(snapshot) &&
      certificate.certificate_hash ===
        hotScoreCertificateHash(certificate.snapshot, certificate.score)
    );
  } catch {
    return false;
  }
}
