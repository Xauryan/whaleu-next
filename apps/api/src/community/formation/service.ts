import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import { AuthorDisplayService } from '../../profile/author-display.service.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunityRepository } from '../community.repository.js';
import type { StoredPost } from '../community.repository.js';
import { actionAllowed, requireAction } from '../community-policy.js';
import type { Authority } from '../community-policy.js';
import { FormationRepository } from './repository.js';
import type { StoredFormation, StoredFormationMember } from './repository.js';
import type {
  FormationContactsView,
  FormationMemberView,
  FormationReceipt,
  FormationView,
  JoinFormation,
} from './contracts.js';
/** Read validation is deliberately separate from normalized, bounded new writes. */
export function safeFormationDisplayText(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= 1024 * 1024 &&
    [...value].every((character) => {
      const code = character.codePointAt(0)!;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 &&
          !(code >= 127 && code <= 159) &&
          !(code >= 0xd800 && code <= 0xdfff))
      );
    })
  );
}
function formationAvailable(formation: StoredFormation): boolean {
  return (
    formation.reconciliation === 'current' &&
    safeFormationDisplayText(formation.theme) &&
    formation.theme.trim().length > 0
  );
}
const terminal = new Set<ApplicationErrorCode>([
  'POST_NOT_FOUND',
  'FORMATION_NOT_FOUND',
  'FORMATION_FULL',
  'FORMATION_ALREADY_JOINED',
  'FORMATION_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
  'COMMUNITY_SCOPE_UNAVAILABLE',
]);
export function formationJoinHash(
  postId: string,
  input: JoinFormation,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operation: 'join_formation',
        postId: postId.toLowerCase(),
        contacts: {
          wechat: input.contacts.wechat,
          qq: input.contacts.qq,
          phone: input.contacts.phone,
        },
        contactSharing: input.contactSharing,
      }),
    )
    .digest('hex');
}
export function formationJoinReason(
  viewer: string | null,
  authority: Authority | null,
  isMember: boolean,
  status: FormationView['status'],
): ApplicationErrorCode | null {
  if (isMember) return 'FORMATION_ALREADY_JOINED';
  if (status === 'unavailable') return 'FORMATION_UNAVAILABLE';
  if (status === 'full') return 'FORMATION_FULL';
  if (!viewer) return 'AUTHENTICATION_REQUIRED';
  if (!authority) return 'COMMUNITY_UNAVAILABLE';
  if (!authority.phoneVerified) return 'PHONE_VERIFICATION_REQUIRED';
  if (authority.restrictedActions.includes('join_formation'))
    return 'COMMUNITY_ACTION_RESTRICTED';
  return null;
}
@Injectable()
export class FormationService {
  constructor(
    @Inject(CommunityRepository)
    private readonly community: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(FormationRepository)
    private readonly formations: FormationRepository,
    @Inject(AuthorDisplayService)
    private readonly profiles: AuthorDisplayService,
  ) {}
  private visibleMember(
    member: StoredFormationMember,
    post: StoredPost,
    viewer: string | null,
    tx: PoolClient,
  ) {
    // The anonymous creator is the parent thread persona. Named joiners are
    // independently safety/block-filtered without making identity IDs public.
    return this.access.visible(
      viewer,
      member.is_creator
        ? post
        : {
            ...post,
            id: member.id,
            account_id: member.account_id,
            author_mode: 'named',
          },
      tx,
      'list_projection',
    );
  }
  private async memberView(
    member: StoredFormationMember,
    post: StoredPost,
    viewer: string | null,
    tx: PoolClient,
  ): Promise<FormationMemberView> {
    let author: FormationMemberView['author'];
    if (member.is_creator && post.author_mode === 'anonymous') {
      const persona = (
        await tx.query<{ id: string; display_name: string }>(
          'SELECT id,display_name FROM whaleu_community.thread_personas WHERE post_id=$1 AND account_id=$2',
          [post.id, member.account_id],
        )
      ).rows[0];
      if (!persona) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      author = {
        kind: 'anonymous',
        personaId: persona.id,
        displayName: persona.display_name,
        avatar: null,
        isPostAuthor: true,
      };
    } else {
      const profile = await this.profiles.find(member.account_id, tx);
      if (!profile) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      author = {
        kind: 'named',
        profileId: profile.profileId,
        displayName: profile.displayName,
        avatar: null,
      };
    }
    return {
      id: member.id,
      author,
      isCreator: member.is_creator,
      joinedAt: member.joined_at.toISOString(),
      viewer: { isSelf: viewer === member.account_id },
    };
  }
  /** Caller owns a currently visible parent and scope lock. No contacts loaded. */
  async project(
    post: StoredPost,
    viewer: string | null,
    authority: Authority | null,
    tx: PoolClient,
  ): Promise<FormationView | null> {
    const formation = await this.formations.find(post.id, tx);
    if (!formation) return null;
    // Discovery remains one-way, but a full roster is a direct-parent projection.
    // A reverse-blocked feed card retains its ordinary card and omits this component.
    if (!(await this.access.visible(viewer, post, tx, 'direct_post')))
      return null;
    const roster = await this.formations.members(formation.id, tx);
    const own = roster.find((member) => member.account_id === viewer);
    const safeTheme = safeFormationDisplayText(formation.theme);
    const status = !formationAvailable(formation)
      ? 'unavailable'
      : roster.length >= formation.capacity
        ? 'full'
        : 'open';
    const members: FormationMemberView[] = [];
    for (const member of roster)
      if (await this.visibleMember(member, post, viewer, tx))
        members.push(await this.memberView(member, post, viewer, tx));
    const reason = formationJoinReason(viewer, authority, !!own, status);
    return {
      id: formation.id,
      postId: post.id,
      capacity: formation.capacity,
      // Invalid historical raw themes remain privately preserved, never coerced
      // into a valid imported definition or leaked through an invalid DTO.
      theme:
        safeTheme && formation.theme.trim()
          ? formation.theme
          : '组局信息待核对',
      status,
      memberCount: roster.length,
      members,
      viewer: {
        isMember: !!own,
        isCreator: own?.is_creator ?? false,
        canJoin: reason === null,
        reason,
        canReadContacts:
          !!own &&
          members.some((member) => member.id === own.id) &&
          status !== 'unavailable' &&
          actionAllowed(authority, 'read_formation_contacts'),
      },
    };
  }
  get(token: string, postId: string): Promise<FormationView> {
    return this.community.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const { post, space } = await this.access.accessiblePost(
        postId,
        actor,
        tx,
      );
      const result = await this.project(
        post,
        actor,
        await this.access.advisory(actor, space, tx),
        tx,
      );
      if (!result) throw new ApplicationError('FORMATION_NOT_FOUND');
      await this.access.actor(token, tx);
      return result;
    });
  }
  contacts(token: string, postId: string): Promise<FormationContactsView> {
    return this.community.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const { post, space } = await this.access.accessiblePost(
        postId,
        actor,
        tx,
      );
      const authority = await this.access.authority(actor, space, tx);
      requireAction(authority, 'read_formation_contacts');
      const formation = await this.formations.find(post.id, tx);
      if (!formation) throw new ApplicationError('FORMATION_NOT_FOUND');
      if (!formationAvailable(formation))
        throw new ApplicationError('FORMATION_UNAVAILABLE');
      const roster = await this.formations.members(formation.id, tx);
      const own = roster.find((member) => member.account_id === actor);
      if (!own || !(await this.visibleMember(own, post, actor, tx)))
        throw new ApplicationError('FORMATION_MEMBERSHIP_REQUIRED');
      const members: FormationContactsView['members'] = [];
      for (const member of roster) {
        if (
          member.contact_sharing !== 'members_v1' ||
          !(await this.visibleMember(member, post, actor, tx))
        )
          continue;
        const supplied = await this.formations.contacts(member.id, tx);
        // A future import may retain historical contacts but must never fabricate
        // consent or expose invalid/unreconciled values through the current DTO.
        if (
          Object.values(supplied).every(safeFormationDisplayText) &&
          Object.values(supplied).some((value) => value.trim())
        )
          members.push({ membershipId: member.id, contacts: supplied });
      }
      const result = { postId: post.id, members };
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1024 * 1024)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      // After all potentially blocking locks, validate the presented token again.
      // Permission/visibility rows are locked by their ports through commit.
      await this.access.actor(token, tx);
      requireAction(
        await this.access.authority(actor, space, tx),
        'read_formation_contacts',
      );
      await this.access.actor(token, tx);
      return result;
    });
  }
  own(token: string, postId: string) {
    return this.community.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const own = await this.formations.own(actor, postId, tx);
      if (!own) throw new ApplicationError('FORMATION_MEMBERSHIP_NOT_FOUND');
      await this.access.actor(token, tx);
      return own;
    });
  }
  join(
    token: string,
    postId: string,
    input: JoinFormation,
  ): Promise<FormationReceipt> {
    const requestId = input.clientRequestId.toLowerCase(),
      hash = formationJoinHash(postId, input);
    return this.community.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      await tx.query(
        'INSERT INTO whaleu_community.formation_requests(account_id,client_request_id,payload_hash) VALUES($1,$2,$3) ON CONFLICT(account_id,client_request_id) DO NOTHING',
        [actor, requestId, hash],
      );
      const row = (
        await tx.query<{
          payload_hash: string;
          receipt: FormationReceipt | null;
        }>(
          'SELECT payload_hash,receipt FROM whaleu_community.formation_requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE',
          [actor, requestId],
        )
      ).rows[0]!;
      if (row.payload_hash !== hash)
        throw new ApplicationError('REQUEST_CONFLICT');
      if (row.receipt) {
        await this.access.actor(token, tx);
        return row.receipt;
      }
      await tx.query('SAVEPOINT formation_work');
      let receipt: FormationReceipt;
      try {
        const { post, space } = await this.access.accessiblePost(
          postId,
          actor,
          tx,
          true,
        );
        requireAction(
          await this.access.authority(actor, space, tx),
          'join_formation',
        );
        const formation = await this.formations.find(post.id, tx, true);
        if (!formation) throw new ApplicationError('FORMATION_NOT_FOUND');
        const roster = await this.formations.members(formation.id, tx);
        if (roster.some((member) => member.account_id === actor))
          throw new ApplicationError('FORMATION_ALREADY_JOINED');
        if (!formationAvailable(formation))
          throw new ApplicationError('FORMATION_UNAVAILABLE');
        if (roster.length >= formation.capacity)
          throw new ApplicationError('FORMATION_FULL');
        await this.profiles.prepare(actor, tx);
        await this.access.actor(token, tx);
        requireAction(
          await this.access.authority(actor, space, tx),
          'join_formation',
        );
        const result = await this.formations.addMember(
          formation.id,
          actor,
          false,
          input.contacts,
          input.contactSharing,
          tx,
        );
        await this.community.event(
          `formation-member:${result.resourceId}:joined`,
          'formation_member_joined',
          result.resourceId,
          tx,
        );
        receipt = {
          requestId,
          operation: 'join_formation',
          outcome: 'created',
          ...result,
        };
      } catch (error) {
        if (!(error instanceof ApplicationError) || !terminal.has(error.code))
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT formation_work');
        receipt = {
          requestId,
          operation: 'join_formation',
          outcome: 'rejected',
          code: error.code,
        };
      }
      await tx.query('RELEASE SAVEPOINT formation_work');
      await tx.query(
        'UPDATE whaleu_community.formation_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
        [actor, requestId, JSON.stringify(receipt)],
      );
      await this.access.actor(token, tx);
      return receipt;
    });
  }
  receipt(token: string, requestId: string): Promise<FormationReceipt> {
    return this.community.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const row = (
        await tx.query<{ receipt: FormationReceipt }>(
          'SELECT receipt FROM whaleu_community.formation_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
          [actor, requestId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.access.actor(token, tx);
      return row.receipt;
    });
  }
}
