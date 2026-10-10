import { sha256 } from 'js-sha256';
import { ClientError } from '../api/errors';
import type { SessionStore } from '../auth/session';
import { decodePostIntent, decodeReceipt } from '../community/contract';
import type { CommunityGateway } from '../community/gateway';
import type {
  PendingAttempt,
  PendingAttemptStore,
} from '../community/pending-attempt';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import type { Clock } from '../platform/contracts';
import { PendingMediaStore } from './pending';
import {
  MediaUploadController,
  type MediaPublicationOwner,
  type UploadView,
} from './upload-controller';
import { unavailableUploadGateway } from './upload-gateway';
import {
  uploadInvalid,
  type PublicationReference,
  type UploadGateway,
  type UploadTransfer,
} from './upload-contracts';

/** Matches the existing server publicationHash('publish_post', postIntent(body)). No body is journaled here. */
export function mediaPublicationReference(
  attempt: PendingAttempt,
): PublicationReference {
  if (attempt.operation !== 'publish_post') uploadInvalid();
  const body = decodePostIntent(attempt.payload);
  const intent = {
    spaceId: body.spaceId,
    category: body.category,
    text: body.text,
    imageAssetIds: body.imageAssetIds,
    authorMode: body.authorMode,
    commentsPolicy: body.commentsPolicy,
    ...(body.trading ? { trading: body.trading } : {}),
    ...(body.component?.kind === 'poll' || body.component?.kind === 'formation'
      ? { component: body.component }
      : {}),
    ...(body.allowAnonymousDm === undefined
      ? {}
      : { allowAnonymousDm: body.allowAnonymousDm }),
  };
  return Object.freeze({
    clientRequestId: body.clientRequestId,
    operation: 'publish_post',
    intentHash: sha256(JSON.stringify({ operation: 'publish_post', intent })),
  });
}
export function mediaPublicationOwner(
  pending: PendingAttemptStore,
  gateway: Pick<CommunityGateway, 'receipt'>,
): MediaPublicationOwner {
  return {
    async receipt(reference, session, cancel) {
      const actor = session.current().credentials?.accountId;
      if (!actor)
        throw new ClientError('auth-required', 'Original account required');
      const original = pending.load(actor);
      if (
        original &&
        JSON.stringify(mediaPublicationReference(original)) !==
          JSON.stringify(reference)
      )
        uploadInvalid();
      const result = decodeReceipt(
        await gateway.receipt(reference.clientRequestId, cancel),
      );
      session.current();
      if (
        result.requestId !== reference.clientRequestId ||
        result.operation !== reference.operation
      )
        uploadInvalid();
      return result;
    },
  };
}
export interface MediaUploadRuntime {
  create(render: (view: UploadView) => void): MediaUploadController;
  beforePublication(attempt: PendingAttempt): void;
}
/** Ordinary runtime supplies no transfer. There is no environment/HTTP synthetic-enable switch.
 * Test DI may construct the concrete gateway/transfer; that is not device/provider acceptance. */
export function createMediaUploadRuntime(options: {
  sessions: SessionStore;
  pending: PendingMediaStore;
  clock: Clock;
  newRequestId: () => Promise<string>;
  gateway?: UploadGateway;
  transfer?: UploadTransfer;
  publication?: MediaPublicationOwner;
  privateViews?: PrivateViewLifecycle;
}): MediaUploadRuntime {
  const { sessions, pending, clock } = options;
  return {
    create: (render) =>
      new MediaUploadController(
        sessions,
        pending,
        options.gateway ?? unavailableUploadGateway,
        options.transfer,
        clock,
        options.newRequestId,
        render,
        options.publication,
        options.privateViews,
      ),
    beforePublication(attempt) {
      const owner = sessions.snapshot();
      if (owner.credentials?.accountId !== attempt.accountId)
        throw new ClientError('stale-session', 'Original media actor required');
      if (
        attempt.operation !== 'publish_post' ||
        attempt.payload.imageAssetIds.length === 0
      )
        return;
      const record = pending.load(attempt.accountId);
      if (
        !record ||
        attempt.payload.imageAssetIds.length !== 1 ||
        attempt.payload.imageAssetIds[0] !== record.assetId ||
        attempt.payload.spaceId !== record.prepare.spaceId ||
        (record.phase !== 'ready_hint' &&
          record.phase !== 'publication_uncertain')
      )
        throw new ClientError(
          'business',
          'Original image is not ready for this publication',
        );
      const publication = mediaPublicationReference(attempt);
      if (record.phase === 'publication_uncertain') {
        if (JSON.stringify(record.publication) !== JSON.stringify(publication))
          uploadInvalid();
        pending.assertStored(record);
        return;
      }
      sessions.assertCurrent(owner);
      pending.update(record, {
        phase: 'publication_uncertain',
        publication,
        lastObservedAt: Math.max(clock.now(), record.lastObservedAt),
      });
    },
  };
}
