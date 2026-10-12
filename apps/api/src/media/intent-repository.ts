import { windowDiscussionMediaRequestHash } from './contracts-window-discussion.js';
import { privateMessageMediaRequestHash } from './contracts-private-message.js';
import { errandMediaRequestHash } from './contracts-errand.js';
import { verificationEvidenceMediaRequestHash } from './contracts-verification-evidence.js';
import { announcementMediaRequestHash } from './contracts-announcement.js';
import { activityMediaRequestHash } from './contracts-activity.js';
import { organizationMediaRequestHash } from './contracts-organization.js';
import { schoolQrMediaRequestHash } from './contracts-school-qr.js';
import { reserveCategoryIconRequestMarker } from './category-icon-request-marker.js';
import { categoryIconMediaRequestHash } from './contracts-category-icon.js';
import {
  reserveRatingsDiscussionRequestMarker,
  rejectRatingsDiscussionRequestMarker,
} from './ratings-discussion-request-marker.js';
import { ratingsDiscussionMemberHash } from './contracts-ratings-discussion.js';
import {
  reserveRatingsRequestMarker,
  rejectRatingsRequestMarker,
} from './ratings-request-marker.js';
import { ratingsMediaRequestHash } from './contracts-ratings.js';
import {
  reserveProfileRequestMarker,
  rejectProfileRequestMarker,
} from './profile-request-marker.js';
import { profileMediaRequestHash } from './contracts-profile.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  ApplicationError,
  MediaRequestRateLimited,
} from '../http/application-error.js';
import { mediaRequestHash } from './contracts-v2.js';
import { mediaMemberRequestHash } from './contracts-v3.js';
import { mediaMemberRequestHash as discussionMemberHash } from './contracts-v4.js';
import { MEDIA_POLICY_VERSION } from './contracts.js';
import type { MediaPrepareScope } from './prepare-scope.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';

export interface MediaIntentReceipt {
  readonly intentId: string;
  readonly expiresAt: number;
  /** No ready claim is made by this preparation-only repository. */
  readonly status:
    | 'prepared'
    | 'processing'
    | 'cancelled'
    | 'expired'
    | 'rejected'
    | 'unavailable';
}
interface IntentRow {
  id: string;
  actor_id: string;
  canonical_intent_hash: string;
  state: string;
  expires_at: Date;
  generation: string;
}
/** Transactional preparation and recovery foundation. No HTTP activation,
 * grants, processing effects or asset approval. Caller holds Safety then current
 * owner authorization; every method refuses an unmanaged transaction. */
export class MediaIntentRepository {
  constructor(private readonly scopes: MediaPrepareScopes) {}
  async prepare(
    capability: MediaPrepareScope,
    tx: PoolClient,
  ): Promise<MediaIntentReceipt> {
    const { input, scope } = this.scopes.require(capability, tx);
    const declaredSha256 =
      'sha256' in input.declaration ? input.declaration.sha256 : null;
    const v2 = declaredSha256 !== null;
    const windowDiscussion =
      'protocol' in input && input.protocol === 'window-discussion-media-v1';
    const privateMessage =
      'protocol' in input && input.protocol === 'private-message-media-v1';
    const errand = 'protocol' in input && input.protocol === 'errand-media-v1';
    const verificationEvidence =
      'protocol' in input &&
      input.protocol === 'verification-evidence-media-v1';
    const profile =
      'protocol' in input && input.protocol === 'profile-media-v1';
    const announcement =
      'protocol' in input && input.protocol === 'announcement-media-v1';
    const activity =
      'protocol' in input && input.protocol === 'activity-media-v1';
    const organization =
      'protocol' in input && input.protocol === 'organization-media-v1';
    const schoolQr =
      'protocol' in input &&
      input.protocol === 'school-configuration-qr-media-v1';
    const categoryIcon =
      'protocol' in input &&
      input.protocol === 'ratings-category-icon-media-v1';
    const ratingsDiscussion =
      'protocol' in input && input.protocol === 'ratings-discussion-media-v1';
    const ratings =
      'protocol' in input && input.protocol === 'ratings-target-media-v1';
    const v3 = 'protocolVersion' in input;
    const protocol = windowDiscussion
      ? 16
      : privateMessage
        ? 15
        : errand
          ? 14
          : verificationEvidence
            ? 13
            : announcement
              ? 12
              : activity
                ? 11
                : organization
                  ? 10
                  : schoolQr
                    ? 9
                    : categoryIcon
                      ? 8
                      : ratingsDiscussion
                        ? 7
                        : ratings
                          ? 6
                          : profile
                            ? 5
                            : v3
                              ? input.protocolVersion
                              : v2
                                ? 2
                                : 1;
    const requestHash = windowDiscussion
      ? windowDiscussionMediaRequestHash(scope.actorAccountId, input)
      : privateMessage
        ? privateMessageMediaRequestHash(scope.actorAccountId, input)
        : errand
          ? errandMediaRequestHash(scope.actorAccountId, input)
          : verificationEvidence
            ? verificationEvidenceMediaRequestHash(scope.actorAccountId, input)
            : announcement
              ? announcementMediaRequestHash(scope.actorAccountId, input)
              : activity
                ? activityMediaRequestHash(scope.actorAccountId, input)
                : organization
                  ? organizationMediaRequestHash(scope.actorAccountId, input)
                  : schoolQr
                    ? schoolQrMediaRequestHash(scope.actorAccountId, input)
                    : categoryIcon
                      ? categoryIconMediaRequestHash(
                          scope.actorAccountId,
                          input,
                        )
                      : ratingsDiscussion
                        ? ratingsDiscussionMemberHash(
                            scope.actorAccountId,
                            input,
                          )
                        : ratings
                          ? ratingsMediaRequestHash(scope.actorAccountId, input)
                          : profile
                            ? profileMediaRequestHash(
                                scope.actorAccountId,
                                input,
                              )
                            : v3
                              ? (input.protocolVersion === 4
                                  ? discussionMemberHash
                                  : mediaMemberRequestHash)(
                                  scope.actorAccountId,
                                  input.batchIdentity,
                                  {
                                    clientRequestId: input.clientRequestId,
                                    memberId: input.memberId,
                                    sourceSlot: input.ordinal,
                                    declaration: input.declaration,
                                  },
                                )
                              : v2
                                ? mediaRequestHash(scope.actorAccountId, input)
                                : null;
    if (ratingsDiscussion) {
      const batch = await tx.query(
        `SELECT id FROM whaleu_media.ratings_discussion_batches WHERE id=$1 AND actor_id=$2 AND state='editing' AND server_scope_id=$3 AND scope_revision=$4 AND identity_hash=$5 FOR UPDATE NOWAIT`,
        [
          input.batchId,
          scope.actorAccountId,
          scope.serverScopeId,
          scope.scopeRevision,
          input.batchIdentityHash,
        ],
      );
      if (batch.rowCount !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    }
    if (v3) {
      const batch = await tx.query(
        `SELECT id FROM whaleu_media.publication_batches WHERE id=$1 AND actor_id=$2 AND state='editing' AND server_scope_id=$3 AND scope_revision=$4 AND identity=$5::jsonb FOR UPDATE`,
        [
          input.batchId,
          scope.actorAccountId,
          scope.serverScopeId,
          scope.scopeRevision,
          JSON.stringify(input.batchIdentity),
        ],
      );
      if (batch.rowCount !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    }
    // Serialize all reservation changes for this account; same-key retry neither
    // allocates another object obligation nor consumes quota a second time.
    await this.actorLock(scope.actorAccountId, tx);
    if (categoryIcon) {
      if (!requestHash) throw new ApplicationError('MEDIA_UNAVAILABLE');
      await reserveCategoryIconRequestMarker(
        scope.actorAccountId,
        input.clientRequestId,
        requestHash,
        tx,
      );
    }
    if (ratingsDiscussion) {
      if (!requestHash) throw new ApplicationError('MEDIA_UNAVAILABLE');
      await reserveRatingsDiscussionRequestMarker(
        scope.actorAccountId,
        input.clientRequestId,
        requestHash,
        tx,
      );
    } else
      await rejectRatingsDiscussionRequestMarker(
        scope.actorAccountId,
        input.clientRequestId,
        tx,
      );
    if (ratings) {
      if (!requestHash) throw new ApplicationError('MEDIA_UNAVAILABLE');
      await reserveRatingsRequestMarker(
        scope.actorAccountId,
        input.clientRequestId,
        requestHash,
        tx,
      );
    } else
      await rejectRatingsRequestMarker(
        scope.actorAccountId,
        input.clientRequestId,
        tx,
      );
    if (profile) {
      if (!requestHash) throw new ApplicationError('MEDIA_UNAVAILABLE');
      await reserveProfileRequestMarker(
        scope.actorAccountId,
        input.clientRequestId,
        requestHash,
        tx,
      );
    } else
      await rejectProfileRequestMarker(
        scope.actorAccountId,
        input.clientRequestId,
        tx,
      );
    const hash = createHash('sha256')
      .update(
        windowDiscussion ||
          privateMessage ||
          errand ||
          verificationEvidence ||
          announcement ||
          activity ||
          organization ||
          schoolQr ||
          categoryIcon ||
          profile ||
          ratings ||
          ratingsDiscussion ||
          v3
          ? `whaleu-media-intent:v${protocol}\n`
          : v2
            ? 'whaleu-media-intent:v2\n'
            : 'whaleu-media-intent:v1\n',
      )
      .update(
        JSON.stringify({
          actor: scope.actorAccountId,
          requestId: input.clientRequestId,
          purpose: scope.purpose,
          ...('publicationRequestId' in input
            ? {
                publicationRequestId: input.publicationRequestId,
                windowId: input.windowId,
                catalogRevision: input.catalogRevision,
                windowRevision: input.windowRevision,
                rootId: input.rootId,
                replyToReplyId: input.replyToReplyId,
              }
            : 'messageRequestId' in input
              ? {
                  conversationId: input.conversationId,
                  messageRequestId: input.messageRequestId,
                }
              : 'batchIdentityHash' in input
                ? {
                    batchId: input.batchId,
                    batchIdentityHash: input.batchIdentityHash,
                    memberId: input.memberId,
                    sourceSlot: input.sourceSlot,
                  }
                : 'editScopeId' in input
                  ? {
                      editScopeId: input.editScopeId,
                      scopeRevision: input.scopeRevision,
                    }
                  : 'draftRevision' in input
                    ? {
                        draftId: input.draftId,
                        draftRevision: input.draftRevision,
                        targetRegionId: input.targetRegionId,
                        slot: input.slot,
                      }
                    : 'applicationId' in input
                      ? {
                          applicationId: input.applicationId,
                          revision: input.revision,
                        }
                      : 'announcementId' in input
                        ? {
                            announcementId: input.announcementId,
                            revision: input.revision,
                            slot: input.slot,
                          }
                        : 'activityId' in input
                          ? {
                              activityId: input.activityId,
                              revision: input.revision,
                              slot: input.slot,
                            }
                          : 'applicationRevision' in input
                            ? {
                                organizationId: input.organizationId,
                                applicationRevision: input.applicationRevision,
                                slot: input.slot,
                              }
                            : 'expectedRevision' in input
                              ? { expectedRevision: input.expectedRevision }
                              : {
                                  draftId: input.draftId,
                                  spaceId: input.spaceId,
                                }),
          serverScopeId: scope.serverScopeId,
          scopeRevision: scope.scopeRevision,
          audience: scope.audience,
          ownerKind: scope.ownerKind,
          resourceKind: scope.resourceKind,
          targetKind: scope.targetKind,
          contentVersion: scope.contentVersion,
          slot: scope.slot,
          ordinal: scope.ordinal,
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          policyVersion: MEDIA_POLICY_VERSION,
          ...(v2 ? { protocolVersion: protocol, sha256: declaredSha256 } : {}),
          ...(v3
            ? { batchId: input.batchId, memberId: input.memberId, requestHash }
            : {}),
        }),
      )
      .digest('hex');
    if (v2) {
      const fence = (
        await tx.query<{ request_hash: string; state: string }>(
          'SELECT request_hash,state FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE',
          [scope.actorAccountId, input.clientRequestId],
        )
      ).rows[0];
      if (fence && fence.request_hash !== requestHash)
        throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
      if (
        fence?.state === 'cancelled_before_prepare' ||
        fence?.state === 'terminal'
      )
        throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
      if (!fence) await reserveMediaRequestKey(scope.actorAccountId, tx);
    }
    const existing = (
      await tx.query<IntentRow>(
        'SELECT * FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE',
        [scope.actorAccountId, input.clientRequestId],
      )
    ).rows[0];
    if (existing) {
      if (existing.canonical_intent_hash !== hash)
        throw new ApplicationError(
          v2 ? 'MEDIA_REQUEST_CONFLICT' : 'MEDIA_UNAVAILABLE',
        );
      return this.receipt(existing, tx);
    }
    const quota = (
      await tx.query<{ active: number; bytes: string }>(
        `SELECT
      (SELECT count(*)::integer FROM whaleu_media.upload_intents WHERE actor_id=$1 AND state IN ('prepared','upload_observed','sealing','processing','awaiting_review') AND expires_at>clock_timestamp()) AS active,
      (SELECT coalesce(sum(reserved_bytes),0)::text FROM whaleu_media.quota_reservations WHERE actor_id=$1 AND window_start=(clock_timestamp() AT TIME ZONE 'UTC')::date) AS bytes`,
        [scope.actorAccountId],
      )
    ).rows[0];
    if (
      !quota ||
      quota.active >= 3 ||
      BigInt(quota.bytes) + BigInt(input.declaration.bytes) >
        100n * 1024n * 1024n
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const id = randomUUID();
    const created = (
      await tx.query<IntentRow>(
        `INSERT INTO whaleu_media.upload_intents
      (id,actor_id,client_request_id,canonical_intent_hash,purpose,audience,owner_kind,resource_kind,target_kind,resource_id,content_version,scope_revision,slot,ordinal,policy_revision,declared_bytes,declared_mime,expires_at,protocol_version,request_hash,declared_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,${windowDiscussion ? '(SELECT expires_at FROM whaleu_media.window_discussion_scopes WHERE id=$10 AND actor_id=$2)' : privateMessage ? '(SELECT expires_at FROM whaleu_media.private_message_scopes WHERE id=$10 AND actor_id=$2)' : errand ? '(SELECT expires_at FROM whaleu_media.errand_scopes WHERE id=$10 AND actor_id=$2)' : verificationEvidence ? '(SELECT expires_at FROM whaleu_media.verification_evidence_scopes WHERE id=$10 AND actor_id=$2)' : announcement ? '(SELECT expires_at FROM whaleu_announcements.media_upload_scopes WHERE id=$10 AND actor_id=$2)' : activity ? '(SELECT expires_at FROM whaleu_activities.media_upload_scopes WHERE id=$10 AND actor_id=$2)' : organization ? '(SELECT expires_at FROM whaleu_organizations.media_upload_scopes WHERE id=$10 AND actor_id=$2)' : schoolQr ? '(SELECT expires_at FROM whaleu_school_configuration.qr_upload_scopes WHERE id=$10 AND actor_id=$2)' : categoryIcon ? '(SELECT expires_at FROM whaleu_ratings.category_icon_upload_scopes WHERE id=$10 AND actor_id=$2)' : ratingsDiscussion ? '(SELECT expires_at FROM whaleu_media.ratings_discussion_batches WHERE server_scope_id=$10 AND actor_id=$2)' : scope.ownerKind === 'ratings' ? '(SELECT expires_at FROM whaleu_ratings.target_cover_upload_scopes WHERE id=$10 AND actor_id=$2)' : scope.ownerKind === 'profile' ? '(SELECT expires_at FROM whaleu_profile.avatar_edits WHERE id=$10 AND actor_id=$2)' : "clock_timestamp()+interval '30 minutes'"},$18,$19,$20) RETURNING *`,
        [
          id,
          scope.actorAccountId,
          input.clientRequestId,
          hash,
          scope.purpose,
          scope.audience,
          scope.ownerKind,
          scope.resourceKind,
          scope.targetKind,
          scope.serverScopeId,
          scope.contentVersion,
          scope.scopeRevision,
          scope.slot,
          scope.ordinal,
          MEDIA_POLICY_VERSION,
          input.declaration.bytes,
          input.declaration.mime,
          protocol,
          requestHash,
          declaredSha256,
        ],
      )
    ).rows[0];
    if (!created) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_media.quota_reservations(intent_id,actor_id,window_start,reserved_bytes) VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'UTC')::date,$3)`,
      [id, scope.actorAccountId, input.declaration.bytes],
    );
    if (v2)
      await tx.query(
        `INSERT INTO whaleu_media.upload_request_fences(actor_id,client_request_id,request_hash,intent_id,state${windowDiscussion || privateMessage || errand || verificationEvidence || announcement || activity || organization || schoolQr || categoryIcon ? ',protocol_namespace' : ''})
       VALUES($1,$2,$3,$4,'active'${windowDiscussion ? ',16' : privateMessage ? ',15' : errand ? ',14' : verificationEvidence ? ',13' : announcement ? ',12' : activity ? ',11' : organization ? ',10' : schoolQr ? ',9' : categoryIcon ? ',8' : ''})`,
        [scope.actorAccountId, input.clientRequestId, requestHash, id],
      );
    return this.receipt(created, tx);
  }
  async status(
    actorAccountId: string,
    intentId: string,
    tx: PoolClient,
  ): Promise<MediaIntentReceipt> {
    this.managed(tx);
    const row = (
      await tx.query<IntentRow>(
        'SELECT * FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 FOR SHARE',
        [intentId, actorAccountId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.receipt(row, tx);
  }
  private managed(tx: PoolClient): void {
    if (!transactionReadEpoch(tx))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
  }
  private async actorLock(actor: string, tx: PoolClient): Promise<void> {
    this.managed(tx);
    await lockMediaActor(actor, tx);
  }
  private async receipt(
    row: IntentRow,
    tx: PoolClient,
  ): Promise<MediaIntentReceipt> {
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]?.now.getTime();
    if (now === undefined || !Number.isFinite(now))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const expiresAt = row.expires_at.getTime();
    const status: MediaIntentReceipt['status'] =
      row.state === 'cancelled'
        ? 'cancelled'
        : row.state === 'rejected'
          ? 'rejected'
          : row.state === 'expired' || expiresAt <= now
            ? 'expired'
            : row.state === 'prepared'
              ? 'prepared'
              : [
                    'upload_observed',
                    'sealing',
                    'processing',
                    'awaiting_review',
                  ].includes(row.state)
                ? 'processing'
                : 'unavailable';
    return Object.freeze({ intentId: row.id, expiresAt, status });
  }
}

/** Mutating request/reservation paths use the same actor lock. Read paths do not. */
export async function lockMediaActor(
  actor: string,
  tx: PoolClient,
): Promise<void> {
  if (!transactionReadEpoch(tx))
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `whaleu:media-reservation:v1:${actor}`,
  ]);
}
/** Includes cancelled-before-prepare keys. Retry of an existing key is free. */
export async function reserveMediaRequestKey(
  actor: string,
  tx: PoolClient,
): Promise<void> {
  const installed =
    (
      await tx.query<{ present: boolean }>(
        "SELECT to_regclass('whaleu_media.ratings_discussion_batch_request_fences') IS NOT NULL AS present",
      )
    ).rows[0]?.present === true;
  const requests = installed
    ? '(SELECT actor_id,created_at FROM whaleu_media.upload_request_fences UNION ALL SELECT actor_id,created_at FROM whaleu_media.ratings_discussion_batch_request_fences) requests'
    : 'whaleu_media.upload_request_fences';
  const row = (
    await tx.query<{
      daily: number;
      recent: number;
      minute_wait_seconds: number;
      daily_wait_seconds: number;
    }>(
      `WITH quota_clock AS MATERIALIZED (SELECT clock_timestamp() observed_at),
       counts AS (
         SELECT count(*)::integer daily,
           count(*) FILTER (WHERE created_at>observed_at-interval '1 minute')::integer recent,
           min(created_at) FILTER (WHERE created_at>observed_at-interval '1 minute') oldest_recent
         FROM ${requests} CROSS JOIN quota_clock WHERE actor_id=$1
           AND created_at >= date_trunc('day',observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       )
       SELECT daily,recent,
         greatest(1,ceil(extract(epoch FROM (oldest_recent+interval '1 minute'-observed_at))))::integer minute_wait_seconds,
         greatest(1,ceil(extract(epoch FROM (((date_trunc('day',observed_at AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC')-observed_at))))::integer daily_wait_seconds
       FROM counts CROSS JOIN quota_clock`,
      [actor],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('MEDIA_RATE_LIMITED');
  if (row.daily >= 100 || row.recent >= 10)
    throw new MediaRequestRateLimited(
      row.daily >= 100
        ? row.daily_wait_seconds
        : Math.min(row.minute_wait_seconds, row.daily_wait_seconds),
    );
}

/** Profile uses the shared reservations and exact intent foundation; its issuer
 * accepts only the independently versioned Profile prepare contract. */
export class ProfileMediaIntentRepository extends MediaIntentRepository {}
