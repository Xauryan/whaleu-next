import { createHash, randomUUID } from 'node:crypto';
import { DeletionError } from './contracts.js';
export type MediaSettlement =
  | { kind: 'waiting'; proof: null; pending: readonly string[] }
  | { kind: 'complete'; proof: string; pending: readonly [] };
interface ObjectVersion {
  bytes: Buffer;
  owners: Set<string>;
  writers: Set<string>;
  stopped: Set<string>;
  unknown: boolean;
}
/** In-memory generated objects only. This is NOT a production storage port. Exact
 * version identity and observed writer retirement are necessary, not a timeout. */
export class SyntheticDeletionMedia {
  /** Process-local generated storage cohort. The fixture durably enrolls this
   * value before accepting a deletion. Restart without the original adapter is
   * UNKNOWN, never evidence that its former objects disappeared. */
  readonly cohortId = randomUUID();
  private readonly objects = new Map<string, ObjectVersion>();
  private readonly obligations = new Map<string, Set<string>>();
  create(owners: readonly string[], bytes: Uint8Array): string {
    const id = randomUUID();
    this.objects.set(id, {
      bytes: Buffer.from(bytes),
      owners: new Set(owners),
      writers: new Set(),
      stopped: new Set(),
      unknown: false,
    });
    return id;
  }
  writer(id: string): { write: (bytes: Uint8Array) => void; stop: () => void } {
    const o = this.exact(id),
      writer = randomUUID();
    o.writers.add(writer);
    return {
      write: (bytes) => {
        if (o.stopped.has(writer)) throw new DeletionError('WRITER_RETIRED');
        o.bytes = Buffer.from(bytes);
      },
      stop: () => {
        o.stopped.add(writer);
      },
    };
  }
  setUnknown(id: string, unknown: boolean) {
    this.exact(id).unknown = unknown;
  }
  exists(id: string): boolean {
    return this.objects.has(id);
  }
  private exact(id: string) {
    const o = this.objects.get(id);
    if (!o) throw new DeletionError('EXACT_VERSION_UNKNOWN');
    return o;
  }
  settle(
    account: string,
    request: string,
    expectedCohort: string | null,
  ): MediaSettlement {
    if (expectedCohort !== this.cohortId)
      return {
        kind: 'waiting',
        proof: null,
        pending: ['MEDIA_COHORT_UNAVAILABLE'],
      };
    let pending = this.obligations.get(request);
    if (!pending) {
      pending = new Set(
        [...this.objects]
          .filter(([, o]) => o.owners.has(account))
          .map(([id]) => id),
      );
      this.obligations.set(request, pending);
    }
    const reasons = new Set<string>();
    for (const id of pending) {
      const o = this.objects.get(id);
      if (!o) continue;
      if (o.unknown) {
        reasons.add('MEDIA_EFFECT_UNKNOWN');
        continue;
      }
      if ([...o.writers].some((w) => !o.stopped.has(w))) {
        reasons.add('MEDIA_WRITER_NOT_QUIESCENT');
        continue;
      }
      o.owners.delete(account);
      if (o.owners.size === 0) {
        o.bytes.fill(0);
        this.objects.delete(id);
      }
    }
    if (reasons.size)
      return { kind: 'waiting', proof: null, pending: [...reasons].sort() };
    if ([...this.objects.values()].some((o) => o.owners.has(account)))
      return {
        kind: 'waiting',
        proof: null,
        pending: ['MEDIA_INVENTORY_CHANGED'],
      };
    return {
      kind: 'complete',
      proof: createHash('sha256')
        .update(
          JSON.stringify([
            'synthetic-exact-media-v1',
            this.cohortId,
            account,
            request,
            [...pending].sort(),
          ]),
        )
        .digest('hex'),
      pending: [],
    };
  }
}
