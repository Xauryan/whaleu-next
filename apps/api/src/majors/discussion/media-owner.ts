import { RatingAuthorizationFacade } from '../../authorization/rating-grants.facade.js';
import { campusCountProofOwner } from '../../campus/count-epochs.js';
async function majorEpoch(tx: PoolClient) {
  const row = (
    await tx.query<{ revision: string }>(
      'SELECT revision::text FROM whaleu_majors.major_catalog_epoch WHERE singleton',
    )
  ).rows[0];
  if (!row) throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
  return row.revision;
}
import { profileCountProofOwner } from '../../profile/count-epochs.js';
import { MajorDiscussionMediaRequiredProof } from '../../media/major-discussion-required-proof.js';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../../identity/identity.service.js';
import { RatingVerificationFacade } from '../../verification/rating-eligibility.facade.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  boundedOwnerProof,
  requiredOwnerEpoch,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionReadEpoch,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import {
  discussionEpoch,
  discussionSource,
  retainDiscussion,
} from './proof.js';
import type {
  PrepareMajorDiscussionMediaInput,
  MajorDiscussionReference,
} from '../../media/contracts-major-discussion.js';
import type { MajorDiscussionMediaAccessPort } from './media/access-port.js';
export interface MajorDiscussionMediaContext {
  majorId: string;
  publicationRequestId: string;
  catalogRevision: string;
  majorRevision: string;
  rootId: string | null;
  replyToReplyId: string | null;
  contextDigest: string;
}
export function majorDiscussionMediaContextDigest(value: {
  actorId: string;
  publicationRequestId: string;
  majorId: string;
  catalogRevision: string;
  majorRevision: string;
  rootId: string | null;
  replyToReplyId: string | null;
  replyToActorId: string | null;
}) {
  return createHash('sha256')
    .update('whaleu:major-discussion-media-context:v1\n' + canonicalJson(value))
    .digest('hex');
}
const profiles = requiredOwnerEpoch(
  profileCountProofOwner,
  'MEDIA_UNAVAILABLE',
);
const campus = requiredOwnerEpoch(campusCountProofOwner, 'MEDIA_UNAVAILABLE');
const topologyProof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'MEDIA_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'MEDIA_UNAVAILABLE', async (read) => {
      await read.query('SELECT whaleu_majors.major_fence()');
      const current = await majorEpoch(read);
      if (facts.some((value) => value !== current))
        throw new ApplicationError('MEDIA_UNAVAILABLE');
    }),
};
type PrepareFact = { actor: string; input: PrepareMajorDiscussionMediaInput };
type Fact = { major: string; source: string; content: string; review: string };
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 50,
  failureCode: 'MEDIA_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'MEDIA_UNAVAILABLE', async (read) => {
      await read.query('SELECT whaleu_majors.major_discussion_fence()');
      const epoch = await discussionEpoch(read);
      for (const f of facts) {
        const source = (
          await read.query<{ source: unknown }>(
            'SELECT whaleu_majors.major_discussion_source($1,clock_timestamp()) source',
            [f.major],
          )
        ).rows[0]?.source;
        if (
          ownerFingerprint(source) !== f.source ||
          epoch.content !== f.content ||
          epoch.review !== f.review
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
      }
    }),
};
@Injectable()
export class MajorDiscussionMediaOwner implements MajorDiscussionMediaAccessPort {
  private readonly pending = new WeakMap<
    PoolClient,
    { epoch: object; facts: Map<string, PrepareFact> }
  >();
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(RatingAuthorizationFacade)
    private readonly authorization: RatingAuthorizationFacade,
  ) {}
  private async eligible(actor: string, tx: PoolClient, publish = false) {
    const phone = await this.verification.phone(actor, tx);
    if (phone.status !== 'verified')
      throw new ApplicationError(
        phone.status === 'unverified'
          ? 'PHONE_VERIFICATION_REQUIRED'
          : 'VERIFICATION_UNAVAILABLE',
      );
    await this.safety.requireAllowed(actor, tx);
    if (publish) {
      const affiliation = await this.verification.affiliation(actor, tx);
      if (affiliation.status !== 'verified') {
        const temporary = await this.verification.temporary(actor, tx);
        if (
          temporary.status !== 'verified' &&
          !(await this.authorization.majorDiscussionBase(actor, tx)).allowed
        )
          throw new ApplicationError('MAJOR_BASE_REQUIRED');
      }
      const until = (
        await tx.query<{ until: string | null }>(
          'SELECT whaleu_majors.major_publish_deadline($1,clock_timestamp())::text until',
          [actor],
        )
      ).rows[0]!.until;
      registerTransactionExactDeadline(tx, until, 'MAJOR_BASE_REQUIRED');
    }
    return {
      phone: phone.fingerprint,
      safety: await this.safety.navigation(tx),
    };
  }
  async retainTopology(tx: PoolClient) {
    const epoch = await majorEpoch(tx),
      campusEpoch = await campus(tx);
    enableRequiredTransactionProof(tx, topologyProof);
    registerRequiredTransactionFact(tx, topologyProof, epoch, epoch);
    return { major: epoch, campus: campusEpoch };
  }
  async context(
    actor: string,
    input: Omit<MajorDiscussionMediaContext, 'contextDigest'>,
    tx: PoolClient,
    allowRecorded = false,
  ) {
    await this.eligible(actor, tx, true);
    const sourceBoundary = (
      await tx.query<{ until: string | null }>(
        'SELECT whaleu_majors.major_discussion_source_boundary(clock_timestamp())::text until',
      )
    ).rows[0]!.until;
    registerTransactionExactDeadline(tx, sourceBoundary, 'MEDIA_UNAVAILABLE');
    const source = await discussionSource(input.majorId, tx);
    if (
      source.catalog !== input.catalogRevision ||
      source.revision !== input.majorRevision
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (
      !allowRecorded &&
      (
        await tx.query(
          'SELECT 1 FROM whaleu_majors.major_discussion_commands WHERE actor_id=$1 AND request_id=$2 UNION ALL SELECT 1 FROM whaleu_majors.major_discussion_media_cancels WHERE actor_id=$1 AND request_id=$2',
          [actor, input.publicationRequestId],
        )
      ).rowCount
    )
      throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
    let replyToActorId: string | null = null;
    for (const [id, root] of [
      [input.rootId, null],
      [input.replyToReplyId, input.rootId],
    ] as const) {
      if (!id) continue;
      const row = (
        await tx.query<{
          actor_id: string;
          root_id: string | null;
          status: string;
        }>(
          'SELECT actor_id,root_id,whaleu_majors.major_discussion_visibility(id,$1,clock_timestamp()) status FROM whaleu_majors.major_discussion_comments WHERE id=$2 AND major_id=$3',
          [actor, id, input.majorId],
        )
      ).rows[0];
      if (!row || row.root_id !== root || row.status !== 'allow')
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      if (id === input.replyToReplyId) replyToActorId = row.actor_id;
    }
    if (!input.rootId && input.replyToReplyId)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      source,
      contextDigest: majorDiscussionMediaContextDigest({
        actorId: actor,
        ...input,
        replyToActorId,
      }),
    };
  }
  async authorizePrepare(
    actor: string,
    input: PrepareMajorDiscussionMediaInput,
    tx: PoolClient,
  ) {
    await profiles(tx);
    await this.retainTopology(tx);
    const context = {
      publicationRequestId: input.publicationRequestId,
      majorId: input.majorId,
      catalogRevision: input.catalogRevision,
      majorRevision: input.majorRevision,
      rootId: input.rootId,
      replyToReplyId: input.replyToReplyId,
    };
    const value = await this.context(actor, context, tx);
    const epoch = transactionReadEpoch(tx);
    if (!epoch) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const pending = this.pending.get(tx);
    const facts =
      pending?.epoch === epoch ? pending.facts : new Map<string, PrepareFact>();
    facts.set(input.clientRequestId, { actor, input });
    this.pending.set(tx, { epoch, facts });
    const expiry = (
      await tx.query<{ expires: string }>(
        "SELECT floor(extract(epoch FROM least(clock_timestamp()+interval '30 minutes',whaleu_majors.major_discussion_deadline($1,clock_timestamp()),whaleu_majors.major_discussion_source_boundary(clock_timestamp())))*1000)::bigint::text expires",
        [input.majorId],
      )
    ).rows[0]!.expires;
    return {
      actorAccountId: actor,
      contextDigest: value.contextDigest,
      expiresAt: Number(expiry),
    };
  }
  async retainCurrent(tx: PoolClient) {
    const pending = this.pending.get(tx);
    this.pending.delete(tx);
    if (!pending || pending.epoch !== transactionReadEpoch(tx)) return;
    if (pending.facts.size)
      await new MajorDiscussionMediaRequiredProof().capture(tx);
    await profiles(tx);
    await this.retainTopology(tx);
    for (const { actor, input } of pending.facts.values()) {
      const epoch = await discussionEpoch(tx);
      const value = await this.context(
        actor,
        {
          publicationRequestId: input.publicationRequestId,
          majorId: input.majorId,
          catalogRevision: input.catalogRevision,
          majorRevision: input.majorRevision,
          rootId: input.rootId,
          replyToReplyId: input.replyToReplyId,
        },
        tx,
      );
      const after = await discussionEpoch(tx);
      if (epoch.content !== after.content || epoch.review !== after.review)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      enableRequiredTransactionProof(tx, proof);
      registerRequiredTransactionFact(
        tx,
        proof,
        input.majorId,
        Object.freeze({
          major: input.majorId,
          source: ownerFingerprint(value.source),
          ...epoch,
        }),
      );
    }
  }
  async authorizeRead(
    token: string,
    reference: MajorDiscussionReference,
    tx: PoolClient,
  ) {
    await lockSafetyPolicy(tx, false);
    const mediaEpoch = await new MajorDiscussionMediaRequiredProof().capture(
        tx,
      ),
      profileEpoch = await profiles(tx),
      topology = await this.retainTopology(tx);
    const session = await this.identity.session(token, tx);
    const access = await this.eligible(session.accountId, tx);
    const source = await discussionSource(reference.majorId, tx);
    const epoch = await discussionEpoch(tx);
    const row = (
      await tx.query<{
        actor_id: string;
        request_id: string;
        root_id: string | null;
        reply_to_reply_id: string | null;
        reply_to_actor_id: string | null;
        catalog_id: string;
        major_revision: string;
        status: string;
        publication_version: number;
      }>(
        'SELECT c.*,whaleu_majors.major_discussion_visibility(c.id,$1,clock_timestamp()) status FROM whaleu_majors.major_discussion_comments c WHERE c.major_id=$2 AND c.id=$3',
        [session.accountId, reference.majorId, reference.commentId],
      )
    ).rows[0];
    if (!row || row.publication_version !== 2 || row.status !== 'allow')
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const images = (
      await tx.query<{
        assetId: string;
        manifestDigest: string;
        bindingId: string;
        ordinal: number;
      }>(
        `SELECT asset_id "assetId",manifest_digest "manifestDigest",binding_id "bindingId",ordinal FROM whaleu_media.major_discussion_appearances WHERE comment_id=$1 ORDER BY ordinal`,
        [reference.commentId],
      )
    ).rows;
    if (
      !images.some(
        (image) =>
          image.bindingId === reference.bindingId &&
          image.ordinal === reference.ordinal,
      )
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await retainDiscussion(
      session.accountId,
      session.sessionId,
      reference.majorId,
      tx,
      { source, epoch },
    );
    await this.identity.session(token, tx);
    return {
      accountId: session.accountId,
      sessionId: session.sessionId,
      actorAccountId: row.actor_id,
      majorId: reference.majorId,
      commentId: reference.commentId,
      publicationRequestId: row.request_id,
      contextDigest: majorDiscussionMediaContextDigest({
        actorId: row.actor_id,
        publicationRequestId: row.request_id,
        majorId: reference.majorId,
        catalogRevision: row.catalog_id,
        majorRevision: row.major_revision,
        rootId: row.root_id,
        replyToReplyId: row.reply_to_reply_id,
        replyToActorId: row.reply_to_actor_id,
      }),
      ownerRevision: ownerFingerprint({
        source,
        epoch,
        mediaEpoch,
        profileEpoch,
        topology,
        access,
      }),
      images,
    };
  }
}
