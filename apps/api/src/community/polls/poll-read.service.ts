import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunityRepository } from '../community.repository.js';
import type { Authority } from '../community-policy.js';
import type { PollView, OwnBallot } from './contracts.js';
import { PollRepository } from './poll.repository.js';
export function voteReason(
  viewer: string | null,
  authority: Authority | null,
  hasVoted: boolean,
  expired: boolean,
): ApplicationErrorCode | null {
  if (hasVoted) return 'POLL_ALREADY_VOTED';
  if (expired) return 'POLL_EXPIRED';
  if (!viewer) return 'AUTHENTICATION_REQUIRED';
  if (!authority) return 'COMMUNITY_UNAVAILABLE';
  if (!authority.phoneVerified) return 'PHONE_VERIFICATION_REQUIRED';
  if (authority.restrictedActions.includes('vote'))
    return 'COMMUNITY_ACTION_RESTRICTED';
  return null;
}
@Injectable()
export class PollReadService {
  constructor(
    @Inject(CommunityRepository)
    private readonly community: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(PollRepository) private readonly polls: PollRepository,
  ) {}
  /** Internal projection only: caller must hold the same visible parent lock. */
  async project(
    postId: string,
    viewer: string | null,
    authority: Authority | null,
    tx: PoolClient,
  ): Promise<PollView | null> {
    const poll = await this.polls.find(postId, tx);
    if (!poll) return null;
    const own = viewer ? await this.polls.own(viewer, postId, tx) : null;
    const expired = await this.polls.expired(poll, tx);
    const options = await this.polls.options(poll.id, tx);
    const count = await tx.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM whaleu_community.poll_ballots WHERE poll_id=$1',
      [poll.id],
    );
    const reason = voteReason(viewer, authority, !!own, expired);
    return {
      id: poll.id,
      postId: poll.post_id,
      question: poll.question,
      selectionMode: poll.selection_mode,
      options,
      deadline: poll.deadline?.toISOString() ?? null,
      expired,
      voterCount: count.rows[0]!.count,
      selectionCount: options.reduce((sum, option) => sum + option.count, 0),
      viewer: {
        hasVoted: !!own,
        selectedOptionIds: own?.selectedOptionIds ?? [],
        canVote: reason === null,
        reason,
      },
    };
  }
  get(token: string, postId: string): Promise<PollView> {
    return this.community.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx);
        const { space } = await this.access.accessiblePost(postId, actor, tx);
        const authority = await this.access.advisory(actor, space, tx);
        const poll = await this.project(postId, actor, authority, tx);
        if (!poll) throw new ApplicationError('POLL_NOT_FOUND');
        return poll;
      },
      { isolationLevel: 'read committed' },
    );
  }
  own(token: string, postId: string): Promise<OwnBallot> {
    return this.community.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      // Receipt/status recovery returns only the original account's IDs/time.
      // No parent authority lookup and no hidden question, label or aggregate.
      const ballot = await this.polls.own(actor, postId, tx);
      if (!ballot) throw new ApplicationError('BALLOT_NOT_FOUND');
      return ballot;
    });
  }
}
