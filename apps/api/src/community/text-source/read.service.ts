import {
  observeReadingFormatter,
  readingCapabilitySchema,
} from '../reading-formatting/capability.js';
import type { ReadingCapability } from '../reading-formatting/capability.js';
import type { RuntimeConfig } from '../../config/config.js';
import { requiredOwnerEpoch } from '../../database/required-owner-proof.js';
import { communityCountProofOwner } from '../count-epochs.js';
import { campusCountProofOwner } from '../../campus/count-epochs.js';
import type { PoolClient } from 'pg';
import { optionalReadingPresentation } from '../reading-formatting/reader.js';
import type { TextSourceReadV2 } from '../reading-formatting/reader.js';
import { Inject, Injectable } from '@nestjs/common';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { ApplicationError } from '../../http/application-error.js';
import { CommunityRepository } from '../community.repository.js';
import type {
  StoredPost,
  StoredComment,
  StoredReply,
} from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { ApprovalRepository } from '../content-review/approval.repository.js';
import type { ApprovalBinding } from '../content-review/approval.repository.js';
import { ContentDefinitionRepository } from '../content-review/content-definition.repository.js';
import { definitionMatchesApproval } from '../content-review/definition-validation.js';
import type { ContentKind } from '../content-review/contracts.js';
import type { Category, AuthorMode } from '../contracts.js';
import { sourcePublicationOperations } from './publication.js';
import { TextReviewRuntime } from '../text-review/runtime.js';
import { prepareTextSource } from './source.js';
import {
  sourceDescriptor,
  textSourceReadSchema,
  textSourceCapabilitySchema,
} from './protocol.js';
import type { TextSourceRead, TextSourceCapability } from './protocol.js';

// Canonical source authority, not optional processing eligibility. These native
// owners retain Scope/Community/Campus facts before any canonical content read;
// the optional presentation checkpoint therefore cannot discard their proofs.
const canonicalCommunityEpoch = requiredOwnerEpoch(
  communityCountProofOwner,
  'COMMUNITY_UNAVAILABLE',
);
const canonicalCampusEpoch = requiredOwnerEpoch(
  campusCountProofOwner,
  'COMMUNITY_UNAVAILABLE',
);

@Injectable()
export class TextSourceReadService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(ApprovalRepository)
    private readonly approvals: ApprovalRepository,
    @Inject(ContentDefinitionRepository)
    private readonly definitions: ContentDefinitionRepository,
    @Inject(TextReviewRuntime) private readonly reviews: TextReviewRuntime,
  ) {}
  @AccountPolicy('browse', 'entry')
  source(
    token: string,
    kind: ContentKind,
    id: string,
  ): Promise<TextSourceRead> {
    return this.repository.database.transaction(
      (tx) => this.canonicalSource(token, kind, id, tx),
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  sourceV2(
    token: string,
    kind: ContentKind,
    id: string,
  ): Promise<TextSourceReadV2> {
    return this.repository.database.transaction(
      async (tx) =>
        optionalReadingPresentation(
          await this.canonicalSource(token, kind, id, tx),
          tx,
        ),
      { isolationLevel: 'read committed' },
    );
  }
  private async canonicalSource(
    token: string,
    kind: ContentKind,
    id: string,
    tx: PoolClient,
  ): Promise<TextSourceRead> {
    enableSafetyRelationshipProof(tx);
    const actor = await this.access.actor(token, tx);
    await canonicalCommunityEpoch(tx);
    await canonicalCampusEpoch(tx);
    // These are the canonical parent-first current access owners, not a DTO
    // fetched in another transaction. They include Review, Media, owner-hidden,
    // category, account and Safety proof, with mandatory final transaction checks.
    const identity =
      kind === 'post'
        ? await this.access
            .accessiblePost(id, actor, tx, false, true)
            .then(({ post }) => ({
              postId: post.id,
              rootCommentId: null,
              text: post.text,
            }))
        : kind === 'comment'
          ? await this.access
              .accessibleComment(id, actor, tx)
              .then(({ post, comment }) => ({
                postId: post.id,
                rootCommentId: comment.id,
                text: comment.text,
              }))
          : await this.access
              .accessibleReply(id, actor, tx)
              .then(({ post, comment, reply }) => ({
                postId: post.id,
                rootCommentId: comment.id,
                text: reply.text,
              }));
    return this.boundSource(kind, id, identity, tx);
  }
  /** Internal: caller has proved and serialized this exact stored node in tx.
   * Null means explicitly verified legacy, never missing source authority.
   * Required Community/Campus evidence is enrolled before optional formatting.
   * Never accepts HTTP source markers, never falls back after a v6 failure. */
  async authorizedReading(
    kind: ContentKind,
    row: StoredPost | StoredComment | StoredReply,
    tx: PoolClient,
  ): Promise<TextSourceReadV2 | null> {
    const authority = await this.publicationAuthority(kind, row, tx);
    if (authority.version !== 6) return null;
    await canonicalCommunityEpoch(tx);
    await canonicalCampusEpoch(tx);
    const identity = {
      postId: kind === 'post' ? row.id : (row as StoredComment).post_id,
      rootCommentId:
        kind === 'post'
          ? null
          : kind === 'comment'
            ? row.id
            : (row as StoredReply).root_comment_id,
      text: row.text,
    };
    return optionalReadingPresentation(
      await this.boundSource(
        kind,
        row.id,
        identity,
        tx,
        row.account_id,
        authority.binding,
      ),
      tx,
    );
  }
  private async publicationAuthority(
    kind: ContentKind,
    row: StoredPost | StoredComment | StoredReply,
    tx: PoolClient,
  ): Promise<{ version: 1 | 2 | 3 | 4 | 5 | 6; binding?: ApprovalBinding }> {
    if (kind === 'post') {
      // Only posts has this physical column. An omitted/future marker is not
      // evidence of legacy, including in historical internal fixture shapes.
      const version = (row as StoredPost).publication_envelope_version;
      if (
        version === 1 ||
        version === 2 ||
        version === 3 ||
        version === 4 ||
        version === 5 ||
        version === 6
      )
        return { version };
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }
    // Children have no publication_envelope_version column. The exact immutable
    // content-version binding is their authority, held FOR SHARE by its owner.
    // This is source-aware-only; legacy repository/DTO shapes remain unchanged.
    const binding = await this.approvals.binding(kind, row.id, tx);
    if (
      !binding ||
      binding.content_kind !== kind ||
      binding.content_id !== row.id ||
      binding.content_version !== 1 ||
      binding.account_id !== row.account_id
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const accepted = await this.approvals.current(binding, tx);
    if (accepted.kind !== 'allow')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    // current() proves the binding/Review envelope and scope agree. Still bind
    // that authority to the exact canonical child just authorized/serialized.
    // Canonical envelopes 2/3/5 are post-only; child versions are 1/4/6.
    const envelope = accepted.value.envelope;
    if (
      binding.envelope_version !== accepted.value.version ||
      binding.envelope_version !== envelope.version ||
      (envelope.version !== 1 &&
        envelope.version !== 4 &&
        envelope.version !== 6) ||
      envelope.accountId !== row.account_id ||
      envelope.purpose !== `publish_${kind}` ||
      envelope.text !== row.text ||
      envelope.postId !== (row as StoredComment).post_id ||
      envelope.rootCommentId !==
        (kind === 'reply' ? (row as StoredReply).root_comment_id : null) ||
      envelope.targetReplyId !==
        (kind === 'reply' ? (row as StoredReply).target_reply_id : null)
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return { version: envelope.version, binding };
  }
  private async boundSource(
    kind: ContentKind,
    id: string,
    identity: { postId: string; rootCommentId: string | null; text: string },
    tx: PoolClient,
    sourceAccountId?: string,
    heldBinding?: ApprovalBinding,
  ): Promise<TextSourceRead> {
    const binding = heldBinding ?? (await this.approvals.binding(kind, id, tx));
    if (!binding) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const accepted = await this.approvals.current(binding, tx);
    if (accepted.kind !== 'allow')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const stored = await this.definitions.current(
      kind,
      id,
      accepted.value.envelope.scope,
      tx,
    );
    if (
      stored.kind !== 'allow' ||
      stored.value.envelope.text !== identity.text ||
      // Current Media was proved above for this exact immutable node in this
      // same managed transaction. No source metadata grants that authority.
      !definitionMatchesApproval(stored.value, accepted.value, true)
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const envelope = stored.value.envelope;
    if (
      sourceAccountId !== undefined &&
      (envelope.version !== 6 ||
        stored.value.authorAccountId !== sourceAccountId ||
        envelope.accountId !== sourceAccountId ||
        envelope.purpose !== `publish_${kind}` ||
        envelope.postId !== (kind === 'post' ? null : identity.postId) ||
        envelope.rootCommentId !==
          (kind === 'reply' ? identity.rootCommentId : null))
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (envelope.version !== 6)
      return textSourceReadSchema.parse({
        version: 1,
        classification: 'legacyPlain',
        kind,
        id,
        ...identity,
      });
    const source = prepareTextSource(
      identity.text,
      sourceDescriptor(envelope.textSource),
      kind,
    );
    if (!source || source.sourceHash !== envelope.textSource.sourceHash)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return textSourceReadSchema.parse({
      version: 1,
      classification: 'reviewedSource',
      kind,
      id,
      ...identity,
      sourceRevision: 1,
      textSource: envelope.textSource,
      readingFormattingEligible: source.readingFormattingEligible,
      presentationStatus: source.readingFormattingEligible
        ? 'not_configured'
        : 'ineligible',
    });
  }
  @AccountPolicy('browse', 'entry')
  capabilities(
    token: string,
    spaceId: string,
    category: Category,
    authorMode: AuthorMode,
  ): Promise<TextSourceCapability> {
    return this.repository.database.transaction(
      (tx) =>
        this.canonicalCapabilities(token, spaceId, category, authorMode, tx),
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  capabilitiesV2(
    token: string,
    spaceId: string,
    category: Category,
    authorMode: AuthorMode,
    requestedMode: RuntimeConfig['COMMUNITY_READING_FORMATTING_PROCESSING'],
  ): Promise<ReadingCapability> {
    return this.repository.database.transaction(
      async (tx) => {
        const source = await this.canonicalCapabilities(
          token,
          spaceId,
          category,
          authorMode,
          tx,
        );
        const formatter = await observeReadingFormatter(tx, requestedMode);
        // Keep the actual mutable optional diagnostic until final proof invalidation.
        readingCapabilitySchema.parse({ ...source, version: 2, formatter });
        return { ...source, version: 2 as const, formatter };
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async canonicalCapabilities(
    token: string,
    spaceId: string,
    category: Category,
    authorMode: AuthorMode,
    tx: PoolClient,
  ): Promise<TextSourceCapability> {
    enableSafetyRelationshipProof(tx);
    const actor = await this.access.actor(token, tx);
    const space = await this.repository.space(spaceId, tx);
    const unavailable = () =>
      textSourceCapabilitySchema.parse({
        version: 1,
        authorMode,
        availability: 'unavailable',
        operations: [],
        formats: [],
        readingFormatting: [],
        media: 'unavailable',
        markdownReferences: 'unavailable',
        formatter: 'not_configured',
      });
    if (
      category === 'feedback' ||
      category === 'trading' ||
      !(await this.reviews.sourceAvailable(space, tx))
    )
      return unavailable();
    const authority = await this.access.advisory(actor, space, tx, {
      publication: true,
    });
    if (!authority) return unavailable();
    const operations = sourcePublicationOperations(
      authority,
      space,
      category,
      authorMode,
    );
    if (!operations.length) return unavailable();
    return textSourceCapabilitySchema.parse({
      version: 1,
      authorMode,
      availability: 'available',
      operations,
      formats: ['plain', 'markdown'],
      readingFormatting: ['auto', 'off'],
      media: 'unavailable',
      markdownReferences: 'unavailable',
      formatter: 'not_configured',
    });
  }
}
