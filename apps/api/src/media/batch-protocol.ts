import * as v3 from './contracts-v3.js';
import * as v4 from './contracts-v4.js';
import { publicationReferenceSchema as postReference } from './contracts-v2.js';
import { z } from 'zod';
export type MediaBatchIdentity = v3.MediaBatchIdentity | v4.MediaBatchIdentity;
export type MediaBatchStatus = v3.MediaBatchStatus | v4.MediaBatchStatus;
export type MediaBatchRecovery =
  | {
      version: 3 | 4;
      state: 'not_recorded';
      batchRequestId: string;
      serverNow: number;
    }
  | { version: 3 | 4; state: 'recorded'; status: MediaBatchStatus };
export type MediaBatchPublicationRecovery =
  | { version: 3 | 4; state: 'unknown'; serverNow: number }
  | { version: 3 | 4; state: 'recorded'; status: MediaBatchStatus };
export type MediaMemberStatus = v3.MediaMemberStatus | v4.MediaMemberStatus;
export type PublicationMediaContext =
  v3.PublicationMediaContext | v4.PublicationMediaContext;
type AnyOperation<T> = T extends unknown
  ? Omit<T, 'operation'> & {
      operation: 'publish_post' | 'publish_comment' | 'publish_reply';
    }
  : never;
export type MediaBatchPublicationCancellation =
  AnyOperation<v3.MediaBatchPublicationCancellation>;
export type MediaBatchFencePublicationResult = {
  version: 3 | 4;
  status: MediaBatchStatus;
  cancellation: MediaBatchPublicationCancellation;
};
export type {
  MediaBatchOrderedAsset,
  MediaBatchCommandKind,
} from './contracts-v3.js';
export type PrepareMediaBatchInput =
  v3.PrepareMediaV3Input | v4.PrepareMediaV4Input;
export const publicationReferenceSchema = z.union([
  postReference,
  v4.publicationReferenceSchema,
]);
export const batchProtocol = (version: 3 | 4) =>
  version === 4 ? v4 : { ...v3, publicationReferenceSchema: postReference };
