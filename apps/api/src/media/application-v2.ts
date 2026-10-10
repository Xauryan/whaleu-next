import type { PoolClient } from 'pg';
import type { ExactObject } from './contracts.js';
import type { StoredObjectMeasurement } from './storage-port.js';
import type {
  MediaCancelV2,
  MediaRequestRecovery,
  MediaStatusV2,
  MediaUploadGrant,
  MediaUploadObserved,
} from './contracts-v2.js';

export const MEDIA_UPLOAD_APPLICATION_V2 = Symbol(
  'MEDIA_UPLOAD_APPLICATION_V2',
);
export interface MediaIngressClaim {
  readonly actorAccountId: string;
  readonly sessionId: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly generation: string;
  readonly grantId: string;
  readonly writerToken: string;
  readonly writerInstanceId: string;
  readonly writerDeadline: number;
  readonly expectedBytes: number;
  readonly expectedMime: 'image/jpeg' | 'image/png';
  readonly expectedSha256: string;
  readonly staging: ExactObject;
  readonly sealed: ExactObject;
  readonly scratch: ExactObject;
}
/** Constructor injection only. All planning is synchronous and effect-free.
 * requireStopped accepts only adapter-issued opaque evidence that this exact
 * writer cannot write again, including scratch. A timer/abort is not evidence. */
export interface MediaIngressPlanningPort {
  readonly writerInstanceId: string;
  plan(attemptId: string): {
    readonly staging: ExactObject;
    readonly sealed: ExactObject;
  };
  scratch(attemptId: string, writerToken: string): ExactObject;
  requireStopped(
    proof: unknown,
    claim: MediaIngressClaim,
    tx: PoolClient,
  ): void;
}
export interface MediaUploadApplicationV2 {
  prepareV2(token: string, input: unknown): Promise<MediaStatusV2>;
  recoverRequest(
    token: string,
    requestId: string,
  ): Promise<MediaRequestRecovery>;
  cancelRequest(
    token: string,
    requestId: string,
    input: unknown,
  ): Promise<MediaRequestRecovery>;
  statusV2(token: string, intentId: string): Promise<MediaStatusV2>;
  finalizeV2(token: string, intentId: string): Promise<MediaStatusV2>;
  cancelV2(token: string, intentId: string): Promise<MediaCancelV2>;
  grant(token: string, intentId: string): Promise<MediaUploadGrant>;
  admit(
    token: string,
    intentId: string,
    grantId: string,
  ): Promise<MediaIngressClaim>;
  /** Called only after the ENTIRE multipart parser completed successfully,
   * never from the file-part end callback or from storage reconciliation. */
  observe(
    token: string,
    claim: MediaIngressClaim,
    measurement: StoredObjectMeasurement,
  ): Promise<MediaUploadObserved>;
  /** Internal failure/close path, independent of a possibly expired bearer. */
  retire(
    claim: MediaIngressClaim,
    proof?: unknown,
    transferredBytes?: number,
  ): Promise<void>;
}
