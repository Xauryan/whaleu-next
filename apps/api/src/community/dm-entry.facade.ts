import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';
import {
  ownerFingerprint,
  requiredOwnerEpoch,
} from '../database/required-owner-proof.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { IdentityService } from '../identity/identity.service.js';
import { PublicProfileFacade } from '../profile/public-profile.facade.js';
import { ProfileVisibilityFacade } from '../safety/profile-visibility.facade.js';
import { safetyCountProofOwner } from '../safety/count-epochs.js';
import { campusCountProofOwner } from '../campus/count-epochs.js';
import { communityCountProofOwner } from './count-epochs.js';
import { CommunityAccessService } from './community-access.service.js';
import { CommunityRepository } from './community.repository.js';
import type {
  StoredPost,
  StoredComment,
  StoredReply,
} from './community.repository.js';
import { ApprovalRepository } from './content-review/approval.repository.js';
import type { ApprovalBinding } from './content-review/approval.repository.js';
import { canonicalJson } from './content-review/contracts.js';
import type { ContentKind } from './content-review/contracts.js';

type Mode = 'named' | 'anonymous';
export type CommunityDmEntry =
  | { kind: 'profile'; profileId: string }
  | { kind: 'post'; postId: string }
  | { kind: 'comment'; postId: string; commentId: string }
  | { kind: 'reply'; postId: string; rootCommentId: string; replyId: string };
export interface DmEntryDisplay {
  readonly mode: Mode;
  readonly displayName: string;
  readonly profileId: string | null;
}
export interface DmResolvedEntry {
  readonly actorAccountId: string;
  readonly peerAccountId: string;
  readonly sourcePostId: string | null;
  readonly sourceScopeKey: string;
  readonly actorMode: Mode;
  readonly peerMode: Mode;
  readonly actorDisplay: DmEntryDisplay;
  readonly peerDisplay: DmEntryDisplay;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly immutableDigest: string;
  readonly digest: string;
}
interface Resolution {
  tx: PoolClient;
  epoch: object;
  materialized: boolean;
  actor: string;
  peer: string;
  postId: string | null;
}
const resolutions = new WeakMap<object, Resolution>();
const captures = [
  communityCountProofOwner,
  safetyCountProofOwner,
  campusCountProofOwner,
].map((owner) => requiredOwnerEpoch(owner, 'COMMUNITY_UNAVAILABLE'));
const absent = new Set([
  'POST_NOT_FOUND',
  'COMMENT_NOT_FOUND',
  'REPLY_NOT_FOUND',
  'POST_BLOCKED_BY_YOU',
  'COMMUNITY_SCOPE_UNAVAILABLE',
]);
const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('profile'), profileId: z.uuid() }),
  z.strictObject({ kind: z.literal('post'), postId: z.uuid() }),
  z.strictObject({
    kind: z.literal('comment'),
    postId: z.uuid(),
    commentId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('reply'),
    postId: z.uuid(),
    rootCommentId: z.uuid(),
    replyId: z.uuid(),
  }),
]);
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
/** Internal exact-source resolver. Private author/persona identifiers never
 * enter public Community projections. It alone creates same-post personas. */
@Injectable()
export class CommunityDmEntryFacade {
  constructor(
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunityRepository) private readonly records: CommunityRepository,
    @Inject(ApprovalRepository) private readonly approvals: ApprovalRepository,
    @Inject(PublicProfileFacade) private readonly profiles: PublicProfileFacade,
    @Inject(ProfileVisibilityFacade)
    private readonly visibility: ProfileVisibilityFacade,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  private async capture(tx: PoolClient) {
    for (const capture of captures) await capture(tx);
  }
  private async named(
    accountId: string,
    tx: PoolClient,
  ): Promise<DmEntryDisplay> {
    const id = await this.profiles.ownReference(accountId, tx);
    const profile = id ? await this.profiles.find(id, tx) : null;
    return frozen({
      mode: 'named',
      displayName: profile?.displayName ?? '鲸鱼用户',
      profileId: profile?.profileId ?? null,
    });
  }
  private async node(
    kind: ContentKind,
    content: StoredPost | StoredComment | StoredReply,
    tx: PoolClient,
  ): Promise<{
    binding: ApprovalBinding;
    provenance: Record<string, unknown>;
  }> {
    const binding = await this.approvals.binding(kind, content.id, tx);
    if (!binding) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const current = await this.approvals.current(binding, tx);
    if (current.kind === 'unavailable')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (current.kind !== 'allow')
      throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
    if (
      binding.account_id !== content.account_id ||
      current.value.envelope.authorMode !== content.author_mode
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return {
      binding,
      provenance: {
        kind,
        id: content.id,
        contentVersion: binding.content_version,
        envelopeVersion: binding.envelope_version,
        decisionId: binding.decision_id,
        definitionDigest: binding.digest,
      },
    };
  }
  private result(
    data: Omit<DmResolvedEntry, 'immutableDigest' | 'digest'>,
    tx: PoolClient,
    materialized = false,
  ): DmResolvedEntry {
    const epoch = transactionReadEpoch(tx);
    if (!epoch) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const digest = ownerFingerprint(canonicalJson(data));
    const result = frozen({ ...data, immutableDigest: digest, digest });
    resolutions.set(result, {
      tx,
      epoch,
      materialized,
      actor: data.actorAccountId,
      peer: data.peerAccountId,
      postId: data.sourcePostId,
    });
    return result;
  }
  async resolve(
    actor: string,
    input: CommunityDmEntry,
    initiationMode: Mode,
    tx: PoolClient,
  ): Promise<DmResolvedEntry> {
    const parsed = entrySchema.safeParse(input);
    if (
      !parsed.success ||
      !z.uuid().safeParse(actor).success ||
      !['named', 'anonymous'].includes(initiationMode)
    )
      throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
    const entry = parsed.data;
    await this.capture(tx);
    try {
      if (entry.kind === 'profile') {
        if (initiationMode !== 'named')
          throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
        const profile = await this.profiles.dmFind(entry.profileId, tx);
        if (
          !profile ||
          profile.accountId === actor ||
          !(await this.identity.dmActiveAccount(profile.accountId, tx))
        )
          throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
        if (
          (await this.visibility.read(actor, profile.accountId, tx)).status !==
          'available'
        )
          throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
        return this.result(
          {
            actorAccountId: actor,
            peerAccountId: profile.accountId,
            sourcePostId: null,
            sourceScopeKey: 'profile-direct',
            actorMode: 'named',
            peerMode: 'named',
            actorDisplay: await this.named(actor, tx),
            peerDisplay: frozen({
              mode: 'named',
              displayName: profile.displayName,
              profileId: profile.profileId,
            }),
            provenance: {
              resolverVersion: 1,
              entry,
              sourcePostId: null,
              sourceNodes: [],
              effectiveAuthorMode: 'named',
              optIn: null,
            },
          },
          tx,
        );
      }
      let post: StoredPost, subject: StoredPost | StoredComment | StoredReply;
      const nodes: {
        kind: ContentKind;
        content: StoredPost | StoredComment | StoredReply;
      }[] = [];
      if (entry.kind === 'post') {
        ({ post } = await this.access.accessiblePost(entry.postId, actor, tx));
        subject = post;
        nodes.push({ kind: 'post', content: post });
      } else if (entry.kind === 'comment') {
        const found = await this.access.accessibleComment(
          entry.commentId,
          actor,
          tx,
        );
        post = found.post;
        subject = found.comment;
        if (post.id !== entry.postId || found.comment.post_id !== entry.postId)
          throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
        nodes.push(
          { kind: 'post', content: post },
          { kind: 'comment', content: found.comment },
        );
      } else {
        const found = await this.access.accessibleReply(
          entry.replyId,
          actor,
          tx,
        );
        post = found.post;
        subject = found.reply;
        if (
          post.id !== entry.postId ||
          found.comment.id !== entry.rootCommentId ||
          found.reply.post_id !== entry.postId ||
          found.reply.root_comment_id !== entry.rootCommentId
        )
          throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
        nodes.push(
          { kind: 'post', content: post },
          { kind: 'comment', content: found.comment },
        );
        if (found.reply.target_reply_id) {
          const target = await this.records.reply(
            found.reply.target_reply_id,
            tx,
            true,
          );
          if (
            target.id === found.reply.id ||
            target.post_id !== post.id ||
            target.root_comment_id !== found.comment.id ||
            BigInt(target.sequence) >= BigInt(found.reply.sequence) ||
            !(await this.access.visible(actor, target, tx, 'list_projection'))
          )
            throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
          nodes.push({ kind: 'reply', content: target });
        }
        nodes.push({ kind: 'reply', content: found.reply });
      }
      if (
        subject.account_id === actor ||
        !(await this.identity.dmActiveAccount(subject.account_id, tx))
      )
        throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
      const definitions = [] as {
        binding: ApprovalBinding;
        provenance: Record<string, unknown>;
      }[];
      for (const node of nodes)
        definitions.push(await this.node(node.kind, node.content, tx));
      let actorMode: Mode, peerMode: Mode;
      if (subject.author_mode === 'anonymous') {
        if (initiationMode !== 'anonymous')
          throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
        actorMode = 'anonymous';
        peerMode = 'anonymous';
      } else if (initiationMode === 'anonymous') {
        const binding = definitions[0]!.binding;
        if (
          entry.kind !== 'post' ||
          post.author_mode !== 'named' ||
          post.publication_envelope_version !== 2 ||
          post.allow_anonymous_dm !== true ||
          binding.envelope_version !== 2 ||
          binding.envelope.version !== 2 ||
          binding.envelope.purpose !== 'publish_post' ||
          binding.envelope.allowAnonymousDm !== true
        )
          throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
        actorMode = 'anonymous';
        peerMode = 'named';
      } else {
        actorMode = 'named';
        peerMode = 'named';
      }
      const anonymous = frozen<DmEntryDisplay>({
        mode: 'anonymous',
        displayName: '匿名鲸鱼',
        profileId: null,
      });
      const provenance = {
        resolverVersion: 1,
        entry,
        sourcePostId: post.id,
        sourceNodes: definitions.map((value) => value.provenance),
        effectiveAuthorMode: subject.author_mode,
        optIn:
          entry.kind === 'post' && post.publication_envelope_version === 2
            ? {
                value: post.allow_anonymous_dm,
                definitionDigest: definitions[0]!.binding.digest,
                decisionId: definitions[0]!.binding.decision_id,
              }
            : null,
        targetReplyId:
          'target_reply_id' in subject ? subject.target_reply_id : null,
        actorPersona: null,
        peerPersona: null,
      };
      return this.result(
        {
          actorAccountId: actor,
          peerAccountId: subject.account_id,
          sourcePostId: post.id,
          sourceScopeKey: post.id,
          actorMode,
          peerMode,
          actorDisplay:
            actorMode === 'named' ? await this.named(actor, tx) : anonymous,
          peerDisplay:
            peerMode === 'named'
              ? await this.named(subject.account_id, tx)
              : anonymous,
          provenance,
        },
        tx,
      );
    } catch (error) {
      if (error instanceof ApplicationError && absent.has(error.code))
        throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
      throw error;
    }
  }
  async materialize(
    resolution: DmResolvedEntry,
    tx: PoolClient,
  ): Promise<DmResolvedEntry> {
    const handle = resolutions.get(resolution);
    if (
      !handle ||
      handle.tx !== tx ||
      handle.epoch !== transactionReadEpoch(tx)
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (handle.materialized) return resolution;
    const persona = async (accountId: string) => {
      if (!handle.postId) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      await this.records.persona(handle.postId, accountId, tx);
      const row = (
        await tx.query<{ id: string; display_name: string }>(
          'SELECT id,display_name FROM whaleu_community.thread_personas WHERE post_id=$1 AND account_id=$2 FOR SHARE',
          [handle.postId, accountId],
        )
      ).rows[0];
      if (
        !row ||
        typeof row.display_name !== 'string' ||
        !row.display_name.trim() ||
        row.display_name.length > 200
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      return {
        id: row.id,
        postId: handle.postId,
        displayName: row.display_name,
      };
    };
    // Stable account order avoids opposite-initiator persona uniqueness deadlocks.
    const personas = new Map<string, Awaited<ReturnType<typeof persona>>>();
    for (const account of [
      { id: handle.actor, mode: resolution.actorMode },
      { id: handle.peer, mode: resolution.peerMode },
    ]
      .filter((p) => p.mode === 'anonymous')
      .sort((a, b) => a.id.localeCompare(b.id)))
      personas.set(account.id, await persona(account.id));
    const actorPersona = personas.get(handle.actor),
      peerPersona = personas.get(handle.peer);
    return this.result(
      {
        actorAccountId: resolution.actorAccountId,
        peerAccountId: resolution.peerAccountId,
        sourcePostId: resolution.sourcePostId,
        sourceScopeKey: resolution.sourceScopeKey,
        actorMode: resolution.actorMode,
        peerMode: resolution.peerMode,
        actorDisplay: actorPersona
          ? {
              mode: 'anonymous',
              displayName: actorPersona.displayName,
              profileId: null,
            }
          : resolution.actorDisplay,
        peerDisplay: peerPersona
          ? {
              mode: 'anonymous',
              displayName: peerPersona.displayName,
              profileId: null,
            }
          : resolution.peerDisplay,
        provenance: {
          ...resolution.provenance,
          actorPersona: actorPersona ?? null,
          peerPersona: peerPersona ?? null,
        },
      },
      tx,
      true,
    );
  }
  async sourceAvailable(
    actor: string,
    postId: string,
    tx: PoolClient,
  ): Promise<boolean> {
    await this.capture(tx);
    try {
      await this.access.accessiblePost(postId, actor, tx);
      return true;
    } catch (error) {
      if (error instanceof ApplicationError && absent.has(error.code))
        return false;
      throw error;
    }
  }
}
