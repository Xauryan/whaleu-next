import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import {
  requiredOwnerEpoch,
  boundedOwnerProof,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { enforceAccountPunishment } from '../../safety/account-moderation/policy.js';
import { campusCountProofOwner } from '../../campus/count-epochs.js';
import { communityCountProofOwner } from '../count-epochs.js';
import { ApprovalRepository } from '../content-review/approval.repository.js';
import { ContentDefinitionRepository } from '../content-review/content-definition.repository.js';
import { definitionMatchesApproval } from '../content-review/definition-validation.js';
import { CurrentContentMediaProof } from '../content-review/media-proof.js';
import { readOwnerPostVisibility } from '../owner-visibility/read-proof.js';
import {
  reconstructTextSource,
  storedSourceDescriptor,
} from '../text-source/repository.js';
import type { ContentKind } from '../content-review/contracts.js';
import { eligible, sourceIdentitySchema, sameIdentity } from './contracts.js';
import type { SourceIdentity, SourceSnapshot } from './contracts.js';
const communityEpoch = requiredOwnerEpoch(
  communityCountProofOwner,
  'COMMUNITY_UNAVAILABLE',
);
const campusEpoch = requiredOwnerEpoch(
  campusCountProofOwner,
  'COMMUNITY_UNAVAILABLE',
);
const categoryProof: RequiredTransactionProof<string> = {
  maximumFacts: 8,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.post_category_heads IN SHARE MODE NOWAIT',
      );
      if (
        (
          await read.query(
            'SELECT post_id FROM whaleu_community.post_category_heads WHERE post_id=ANY($1::uuid[])',
            [facts],
          )
        ).rowCount
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }),
};
interface Node {
  kind: ContentKind;
  id: string;
  account_id: string;
}
const tables = {
  post: 'posts',
  comment: 'root_comments',
  reply: 'replies',
} as const;
/** No public permit factory and no synthetic callbacks. The only successful
 * output is reconstructed through actual canonical owners in a managed TX. */
@Injectable()
export class ReadingSourceOwner {
  constructor(
    @Inject(ApprovalRepository) private readonly approvals: ApprovalRepository,
    @Inject(ContentDefinitionRepository)
    private readonly definitions: ContentDefinitionRepository,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  async resolve(
    expected: SourceIdentity,
    tx: PoolClient,
  ): Promise<SourceSnapshot> {
    sourceIdentitySchema.parse(expected);
    if (!transactionReadEpoch(tx))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    await tx.query(
      "SET LOCAL lock_timeout='5ms'; SET LOCAL statement_timeout='1000ms'",
    );
    await lockSafetyPolicy(tx);
    await communityEpoch(tx);
    await campusEpoch(tx);
    const reference = (
      await tx.query<{
        post_id?: string;
        root_comment_id?: string;
        account_id: string;
      }>(
        `SELECT * FROM whaleu_community.${tables[expected.kind]} WHERE id=$1`,
        [expected.id],
      )
    ).rows[0];
    if (!reference) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const postId = expected.kind === 'post' ? expected.id : reference.post_id;
    if (!postId) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const nodes: Node[] = [];
    const post = (
      await tx.query<{ id: string; account_id: string }>(
        'SELECT id,account_id FROM whaleu_community.posts WHERE id=$1',
        [postId],
      )
    ).rows[0];
    if (!post) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    nodes.push({ kind: 'post', ...post });
    if (expected.kind !== 'post') {
      const root = (
        await tx.query<{ id: string; account_id: string }>(
          'SELECT id,account_id FROM whaleu_community.root_comments WHERE id=$1 AND post_id=$2',
          [
            expected.kind === 'comment'
              ? expected.id
              : reference.root_comment_id,
            postId,
          ],
        )
      ).rows[0];
      if (!root) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      nodes.push({ kind: 'comment', ...root });
      if (expected.kind === 'reply')
        nodes.push({
          kind: 'reply',
          id: expected.id,
          account_id: reference.account_id,
        });
    }
    if (
      (
        await this.identity.processingAccountState(
          nodes.map((n) => n.account_id),
          tx,
        )
      ).some((a) => a.status !== 'active' || a.lifecycle !== 'active')
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    let source: SourceSnapshot | undefined;
    for (const [index, node] of nodes.entries()) {
      await tx.query(
        `SELECT id FROM whaleu_community.${tables[node.kind]} WHERE id=$1 FOR SHARE NOWAIT`,
        [node.id],
      );
      const binding = await this.approvals.binding(node.kind, node.id, tx);
      if (!binding) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      const accepted = await this.approvals.current(binding, tx);
      if (accepted.kind !== 'allow')
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      const current = await this.definitions.current(
        node.kind,
        node.id,
        accepted.value.envelope.scope,
        tx,
      );
      if (current.kind !== 'allow')
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      const actual = current.value,
        e = actual.envelope;
      if (
        actual.authorAccountId !== node.account_id ||
        ![1, 2, 6].includes(e.version) ||
        e.scope.sync !== 'none' ||
        e.component.kind !== 'none' ||
        e.trading !== null ||
        !definitionMatchesApproval(actual, accepted.value, true) ||
        JSON.stringify(actual.parents) !==
          JSON.stringify(
            nodes.slice(0, index).map(({ kind, id }) => ({ kind, id })),
          )
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      const media = new CurrentContentMediaProof();
      const mediaDecision = e.images.length
        ? await media.current(node.kind, node.id, e.images, tx)
        : await media.absent(node.kind, node.id, tx);
      if (mediaDecision.kind !== 'allow')
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      if (node.kind === expected.kind && node.id === expected.id) {
        const stored = actual.textSource;
        if (
          e.version !== 6 ||
          !stored ||
          !reconstructTextSource(
            stored,
            node.kind,
            node.id,
            node.account_id,
            e.text,
          )
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        source = {
          kind: node.kind,
          id: node.id,
          sourceRevision: 1,
          sourceHash: stored.source_hash,
          publicationRequestId: stored.client_request_id,
          text: e.text,
          descriptor: storedSourceDescriptor(stored),
        };
      }
    }
    if (!source || !sameIdentity(source, expected) || !eligible(source))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if ((await readOwnerPostVisibility(postId, tx)).ownerHidden)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    enableRequiredTransactionProof(tx, categoryProof);
    if (
      (
        await tx.query(
          'SELECT post_id FROM whaleu_community.post_category_heads WHERE post_id=$1',
          [postId],
        )
      ).rowCount
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    registerRequiredTransactionFact(tx, categoryProof, postId, postId);
    await enforceAccountPunishment(
      reference.account_id,
      'passive_bookkeeping',
      tx,
    );
    return source;
  }
}
