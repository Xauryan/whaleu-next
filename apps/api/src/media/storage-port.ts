import type { Readable } from 'node:stream';
import type { ExactObject } from './contracts.js';

export interface StoredObjectMeasurement {
  readonly object: ExactObject;
  readonly bytes: number;
  readonly sha256: string;
}
/** Effects execute outside database transactions. Their exact destination is
 * persisted in object_attempts BEFORE the effect. An existing destination must
 * be verified against the same source; success cannot mean blindly overwriting.
 * Storage never grants owner authorization and cannot make an asset ready. */
export interface ImmutableMediaStorage {
  readonly provider: string;
  readonly environment: string;
  seal(
    source: ExactObject,
    destination: ExactObject,
  ): Promise<StoredObjectMeasurement>;
  openExact(
    object: ExactObject,
    maximumBytes: number,
  ): Promise<{
    readonly stream: Readable;
    readonly bytes: number;
  }>;
  deleteExact(object: ExactObject): Promise<'confirmed-absent'>;
}
