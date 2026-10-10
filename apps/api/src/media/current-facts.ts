import { currentMediaSafety } from './current-safety.js';
import type { MediaSafetyEvent } from './current-safety.js';
import { sealManifest } from './manifest.js';
import type { MediaManifest } from './contracts.js';

export interface CurrentMediaAssetFacts {
  manifest: unknown;
  manifest_digest: string;
  policy_revision: string;
}
export type ValidatedCurrentMedia =
  | { decision: 'unknown'; validUntil: null }
  | { decision: 'allow' | 'deny'; validUntil: number; manifest: MediaManifest };

/** Shared scalar/batch validator. The database supplies exact timestamp ordering;
 * Date milliseconds alone cannot authorize a future microsecond event. The
 * deadline is deliberately floored, never rounded up. This function registers
 * no transaction facts and never grants business/viewer authority. */
export function validateCurrentMedia(
  asset: CurrentMediaAssetFacts,
  intentState: string | undefined,
  event: MediaSafetyEvent | undefined,
  now: number | undefined,
  exactTimeValid: boolean,
): ValidatedCurrentMedia {
  if (intentState !== 'ready' || !exactTimeValid)
    return { decision: 'unknown', validUntil: null };
  const decision = currentMediaSafety(
    event,
    asset.manifest_digest,
    asset.policy_revision,
    now,
  );
  if (decision === 'unknown' || !event)
    return { decision: 'unknown', validUntil: null };
  try {
    const sealed = sealManifest(asset.manifest);
    if (
      sealed.digest !== asset.manifest_digest ||
      sealed.manifest.policyVersion !== asset.policy_revision
    )
      return { decision: 'unknown', validUntil: null };
    return {
      decision,
      validUntil: event.valid_until.getTime(),
      manifest: sealed.manifest,
    };
  } catch {
    return { decision: 'unknown', validUntil: null };
  }
}
