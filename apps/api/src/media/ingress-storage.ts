import type { Readable } from 'node:stream';
import type {
  MediaIngressClaim,
  MediaIngressPlanningPort,
} from './application-v2.js';
import type { StoredObjectMeasurement } from './storage-port.js';

export const MEDIA_INGRESS_STORAGE = Symbol('MEDIA_INGRESS_STORAGE');
/** No production provider implements this port yet. Constructor-injected test
 * providers are the only enabled route. Abort is a request to stop, not proof. */
export interface MediaIngressStorage extends MediaIngressPlanningPort {
  write(
    claim: MediaIngressClaim,
    source: Readable,
    signal: AbortSignal,
  ): Promise<StoredObjectMeasurement>;
  /** Irrevocably forbids this writer token, then waits for all of its writes to
   * finish. Unknown foreign instances must reject rather than infer death. */
  quiesce(claim: MediaIngressClaim): Promise<object>;
  /** Only this request's registered scratch; never the committed destination. */
  removeScratch(claim: MediaIngressClaim): Promise<'confirmed-absent'>;
}
