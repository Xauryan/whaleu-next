import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Readable } from 'node:stream';
import type { MediaIngressClaim } from '../../../src/media/application-v2.js';
import type { ExactObject } from '../../../src/media/contracts.js';
import { mediaIdSchema } from '../../../src/media/contracts.js';
import type { MediaIngressStorage } from '../../../src/media/ingress-storage.js';
import type { StoredObjectMeasurement } from '../../../src/media/storage-port.js';
import { SyntheticMediaStorage } from './synthetic-storage.js';

/** TEST ONLY: sole-process writer evidence; restart/foreign instance is unknown.
 * No heartbeat/timeout/absence inference can mint a stopped-writer capability. */
export class SyntheticMediaIngressStorage implements MediaIngressStorage {
  readonly writerInstanceId = randomUUID();
  private readonly writers = new Map<
    string,
    {
      identity: string;
      stopped: boolean;
      write?: Promise<StoredObjectMeasurement>;
    }
  >();
  private readonly proofs = new WeakMap<object, string>();
  constructor(readonly storage: SyntheticMediaStorage) {}
  plan(_attemptId: string): { staging: ExactObject; sealed: ExactObject } {
    return {
      staging: this.storage.newObject(),
      sealed: this.storage.newObject(),
    };
  }
  scratch(attemptId: string, writerToken: string): ExactObject {
    return Object.freeze({
      provider: this.storage.provider,
      environment: this.storage.environment,
      bucket: 'synthetic',
      key: mediaIdSchema.parse(attemptId),
      version: mediaIdSchema.parse(writerToken),
    });
  }
  private identity(claim: MediaIngressClaim): string {
    if (claim.writerInstanceId !== this.writerInstanceId)
      throw new Error('SYNTHETIC_INGRESS_FOREIGN_WRITER');
    return JSON.stringify([
      claim.intentId,
      claim.generation,
      claim.attemptId,
      claim.writerToken,
      claim.writerInstanceId,
      claim.staging,
      claim.scratch,
    ]);
  }
  async write(claim: MediaIngressClaim, source: Readable, signal: AbortSignal) {
    const identity = this.identity(claim);
    if (this.writers.has(claim.writerToken))
      throw new Error('SYNTHETIC_INGRESS_ALREADY_CLAIMED');
    const entry: {
      identity: string;
      stopped: boolean;
      write?: Promise<StoredObjectMeasurement>;
    } = { identity, stopped: false };
    this.writers.set(claim.writerToken, entry);
    const abort = () => source.destroy(new Error('SYNTHETIC_INGRESS_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    entry.write = this.storage.writePlannedStream(
      claim.staging,
      claim.scratch,
      source,
    );
    try {
      return await entry.write;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async quiesce(claim: MediaIngressClaim): Promise<object> {
    const identity = this.identity(claim);
    let entry = this.writers.get(claim.writerToken);
    if (!entry) {
      entry = { identity, stopped: true };
      this.writers.set(claim.writerToken, entry);
    }
    if (entry.identity !== identity)
      throw new Error('SYNTHETIC_INGRESS_WRITER_MISMATCH');
    // Set before awaiting: no future write may start for this writer token.
    entry.stopped = true;
    await entry.write?.catch(() => undefined);
    const proof = Object.freeze({});
    this.proofs.set(proof, identity);
    return proof;
  }
  requireStopped(
    proof: unknown,
    claim: MediaIngressClaim,
    _tx: PoolClient,
  ): void {
    const identity = this.identity(claim);
    if (
      typeof proof !== 'object' ||
      proof === null ||
      this.proofs.get(proof) !== identity ||
      this.writers.get(claim.writerToken)?.stopped !== true
    )
      throw new Error('SYNTHETIC_INGRESS_NOT_QUIESCENT');
  }
  async removeScratch(claim: MediaIngressClaim): Promise<'confirmed-absent'> {
    const identity = this.identity(claim);
    const entry = this.writers.get(claim.writerToken);
    if (!entry || entry.identity !== identity || !entry.stopped)
      throw new Error('SYNTHETIC_INGRESS_NOT_QUIESCENT');
    await entry.write?.catch(() => undefined);
    return this.storage.deleteExact(claim.scratch);
  }
}
