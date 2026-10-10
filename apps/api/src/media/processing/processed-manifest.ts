import type { ExactObject } from '../contracts.js';
import { MEDIA_POLICY_VERSION, MEDIA_TRANSFORM_VERSION } from '../contracts.js';
import { sealManifest } from '../manifest.js';
import type { StoredObjectMeasurement } from '../storage-port.js';
import { MediaProcessingError, sha256 } from './protocol.js';
import type { ProcessedImage } from './protocol.js';

/** Called only after exact immutable storage writes are independently measured.
 * This produces immutable evidence, NOT ready/review allow or owner permission.
 * Durable object attempts must already name the source and both destinations. */
export function sealProcessedManifest(
  processed: ProcessedImage,
  original: ExactObject,
  destinations: readonly [StoredObjectMeasurement, StoredObjectMeasurement],
) {
  const variants = processed.variants.map((variant, index) => {
    const stored = destinations[index]!;
    if (
      stored.bytes !== variant.bytes ||
      stored.sha256 !== variant.sha256 ||
      variant.data.length !== variant.bytes ||
      sha256(variant.data) !== variant.sha256
    )
      throw new MediaProcessingError('MEDIA_OUTPUT_REJECTED');
    return {
      name: variant.name,
      object: stored.object,
      sha256: variant.sha256,
      bytes: variant.bytes,
      mime: variant.mime,
      width: variant.width,
      height: variant.height,
    };
  });
  return sealManifest({
    version: 1,
    policyVersion: MEDIA_POLICY_VERSION,
    transformVersion: MEDIA_TRANSFORM_VERSION,
    original: { ...processed.original, object: original },
    variants,
  });
}
