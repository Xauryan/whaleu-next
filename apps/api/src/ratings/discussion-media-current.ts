import {
  ratingsMediaMutationActive,
  collectRatingsMediaMutationRead,
} from '../media/ratings-discussion-mutation-proof.js';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  transactionReadEpoch,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import { MediaRequiredProof } from '../media/required-proof.js';
import {
  RatingsDiscussionMediaContentSnapshotFacade,
  ratingsDiscussionMediaContentKey,
  type RatingsDiscussionMediaContentFact,
} from '../media/ratings-discussion-content-snapshot.facade.js';
import {
  ratingsDiscussionMediaDescriptorSchema,
  type RatingsDiscussionMediaParent,
} from '../media/contracts-ratings-discussion.js';
import {
  canonicalRatingDiscussionMediaEnvelope,
  type RatingDiscussionMediaEnvelope,
} from '../community/content-review/rating-discussion-media-contracts.js';
import {
  assertResolvedRatingScope,
  type ResolvedRatingReadScope,
} from './scoped/context.service.js';
import { requireDiscussionMediaCapabilities } from './scoped/discussion-media-capability.js';
import { retainRatingReadBytes } from './target-cover-current.js';
const snapshots = new RatingsDiscussionMediaContentSnapshotFacade(),
  proof = new MediaRequiredProof();
const states = new WeakMap<
  PoolClient,
  {
    epoch: object;
    scopes: Map<string, ResolvedRatingReadScope>;
    capabilities: Set<string>;
    facts: Map<
      string,
      { expected: string; fact: RatingsDiscussionMediaContentFact }
    >;
  }
>();
function state(tx: PoolClient) {
  const epoch = transactionReadEpoch(tx);
  if (!epoch) throw new ApplicationError('MEDIA_UNAVAILABLE');
  let value = states.get(tx);
  if (!value || value.epoch !== epoch) {
    value = {
      epoch,
      scopes: new Map(),
      capabilities: new Set(),
      facts: new Map(),
    };
    states.set(tx, value);
  }
  return value;
}
const scopeKey = (actor: string, targetId: string) =>
  JSON.stringify([actor, targetId]);
export function retainRatingDiscussionScope(
  scope: ResolvedRatingReadScope,
  targetId: string,
  tx: PoolClient,
): void {
  assertResolvedRatingScope(scope, tx);
  const scopes = state(tx).scopes,
    key = scopeKey(scope.actor, targetId),
    old = scopes.get(key);
  if (!old && scopes.size >= 256)
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  if (
    old &&
    (old.actor !== scope.actor ||
      old.catalog.id !== scope.catalog.id ||
      old.protocolGeneration !== scope.protocolGeneration)
  )
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  scopes.set(key, scope);
}
export function discussionMediaParent(
  envelope: RatingDiscussionMediaEnvelope,
): RatingsDiscussionMediaParent {
  return envelope.purpose === 'publish_rating_comment_media_scoped'
    ? {
        ownerKind: 'ratings',
        resourceKind: 'rating_comment',
        targetId: envelope.targetId,
        resourceId: envelope.subjectId,
        contentVersion: 1,
      }
    : {
        ownerKind: 'ratings',
        resourceKind: 'rating_reply',
        targetId: envelope.targetId,
        rootId: envelope.rootId,
        resourceId: envelope.subjectId,
        contentVersion: 1,
      };
}
async function capability(
  envelope: RatingDiscussionMediaEnvelope,
  actor: string,
  tx: PoolClient,
) {
  try {
    const current = state(tx),
      scope = current.scopes.get(scopeKey(actor, envelope.targetId));
    if (!scope) throw new ApplicationError('MEDIA_UNAVAILABLE');
    assertResolvedRatingScope(scope, tx);
    const key = `${scope.catalog.regionId ?? 'global'}:${scope.protocolGeneration}`;
    if (!current.capabilities.has(key)) {
      const rows = (
        await tx.query<{ id: string }>(
          "SELECT id FROM whaleu_ratings.scope_protocol_versions WHERE logical_scope_key=$1 AND generation=$2 AND phase='adopted'",
          [scope.catalog.regionId ?? 'global', scope.protocolGeneration],
        )
      ).rows;
      if (rows.length !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
      await requireDiscussionMediaCapabilities([rows[0]!.id], tx);
      current.capabilities.add(key);
    }
    return scope;
  } catch (error) {
    // Missing/expired source or capability is uncertainty, never a suppressed
    // notification. The caller separately decides a known viewer denial.
    if (error instanceof ApplicationError)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    throw error;
  }
}

/** Retains all metadata once per exact parent in one shared 64 MiB ledger.
 * Consumers must validate the real ancestor chain and Review before publishing
 * output. Quoted reply-to references are intentionally absent from Media parent. */
export async function currentRatingDiscussionMediaBatch(
  raw: readonly RatingDiscussionMediaEnvelope[],
  actor: string,
  tx: PoolClient,
): Promise<readonly ('allow' | 'deny' | 'unavailable')[]> {
  if (raw.length > 256) throw new ApplicationError('MEDIA_UNAVAILABLE');
  const envelopes = raw.map(canonicalRatingDiscussionMediaEnvelope),
    current = state(tx);
  for (const envelope of envelopes) await capability(envelope, actor, tx);
  const references = envelopes.map((envelope) => ({
    parent: discussionMediaParent(envelope),
    expected: envelope.images.map((image) => ({
      assetId: image.assetId,
      digest: image.manifestDigest,
    })),
  }));
  const missing = references.filter(
    (reference) =>
      !current.facts.has(ratingsDiscussionMediaContentKey(reference.parent)),
  );
  if (missing.length) {
    if (!ratingsMediaMutationActive(tx)) await proof.capture(tx);
    const budget = {
      async rows<T>(
        read: PoolClient,
        sql: string,
        values: unknown[],
        cap: number,
      ) {
        const rows = (await read.query(sql, values)).rows as T[];
        if (rows.length > cap) throw new ApplicationError('MEDIA_UNAVAILABLE');
        retainRatingReadBytes(tx, rows);
        return rows;
      },
    };
    const facts = await snapshots.readBatch(missing, tx, budget);
    collectRatingsMediaMutationRead(tx, missing, facts, budget);
    for (const reference of missing) {
      const key = ratingsDiscussionMediaContentKey(reference.parent),
        fact = facts.get(key);
      if (fact)
        current.facts.set(key, {
          expected: JSON.stringify(reference.expected),
          fact,
        });
    }
  }
  return Object.freeze(
    envelopes.map((envelope) => {
      const entry = current.facts.get(
        ratingsDiscussionMediaContentKey(discussionMediaParent(envelope)),
      );
      if (
        !entry ||
        entry.expected !==
          JSON.stringify(
            envelope.images.map((image) => ({
              assetId: image.assetId,
              digest: image.manifestDigest,
            })),
          ) ||
        entry.fact.decision === 'unknown'
      )
        return 'unavailable' as const;
      if (envelope.images.length === 0)
        return entry.fact.decision === 'allow' &&
          entry.fact.attachments.length === 0
          ? ('allow' as const)
          : ('unavailable' as const);
      if (
        entry.fact.validUntil === null ||
        !Number.isFinite(entry.fact.validUntil)
      )
        return 'unavailable' as const;
      registerTransactionDeadline(
        tx,
        entry.fact.validUntil,
        'MEDIA_UNAVAILABLE',
      );
      return entry.fact.decision;
    }),
  );
}
export async function currentRatingDiscussionMedia(
  envelope: RatingDiscussionMediaEnvelope,
  actor: string,
  tx: PoolClient,
) {
  const scope = await capability(envelope, actor, tx);
  if (scope.actor !== actor)
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  return (await currentRatingDiscussionMediaBatch([envelope], actor, tx))[0]!;
}
export function currentRatingDiscussionDescriptors(
  raw: RatingDiscussionMediaEnvelope,
  actor: string,
  tx: PoolClient,
) {
  const envelope = canonicalRatingDiscussionMediaEnvelope(raw),
    current = state(tx),
    scope = current.scopes.get(scopeKey(actor, envelope.targetId));
  if (!scope || !('context' in scope) || scope.context.protocolVersion !== 4)
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  assertResolvedRatingScope(scope, tx);
  const entry = current.facts.get(
    ratingsDiscussionMediaContentKey(discussionMediaParent(envelope)),
  );
  if (
    !entry ||
    entry.fact.decision !== 'allow' ||
    entry.fact.attachments.length !== envelope.images.length
  )
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  return entry.fact.attachments.map((image, ordinal) =>
    ratingsDiscussionMediaDescriptorSchema.parse({
      protocol: 'ratings-discussion-media-v1',
      kind: 'ratings-discussion-media',
      targetId: envelope.targetId,
      rootId:
        envelope.purpose === 'publish_rating_comment_media_scoped'
          ? envelope.subjectId
          : envelope.rootId,
      replyId:
        envelope.purpose === 'publish_rating_comment_media_scoped'
          ? null
          : envelope.subjectId,
      subjectRevision: envelope.subjectRevision,
      contextId: scope.context.id,
      contextToken: scope.context.token,
      bindingId: image.bindingId,
      ordinal,
      attachmentSetDigest: envelope.attachmentSetDigest,
      width: image.width,
      height: image.height,
      variants: ['thumb-v1', 'display-v1'],
    }),
  );
}
