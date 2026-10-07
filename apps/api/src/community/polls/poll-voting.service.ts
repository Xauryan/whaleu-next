import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../http/application-error.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunityRepository } from '../community.repository.js';
import { requireAction } from '../community-policy.js';
import { PollRepository } from './poll.repository.js';
import {
  BallotRequestsRepository,
  ballotHash,
} from './ballot-requests.repository.js';
import type { BallotReceipt, CastBallot } from './contracts.js';
@Injectable()
export class PollVotingService {
  constructor(
    @Inject(CommunityRepository)
    private readonly community: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(PollRepository) private readonly polls: PollRepository,
    @Inject(BallotRequestsRepository)
    private readonly requests: BallotRequestsRepository,
  ) {}
  cast(
    token: string,
    postId: string,
    body: CastBallot,
  ): Promise<BallotReceipt> {
    return this.requests.execute(
      token,
      body.clientRequestId,
      ballotHash(postId, body.optionIds),
      async (actor, tx) => {
        const { space } = await this.access.accessiblePost(
          postId,
          actor,
          tx,
          true,
        );
        const authority = await this.access.authority(actor, space, tx);
        requireAction(authority, 'vote');
        const poll = await this.polls.find(postId, tx, true);
        if (!poll) throw new ApplicationError('POLL_NOT_FOUND');
        if (await this.polls.own(actor, postId, tx))
          throw new ApplicationError('POLL_ALREADY_VOTED');
        if (await this.polls.expired(poll, tx))
          throw new ApplicationError('POLL_EXPIRED');
        const options = await this.polls.options(poll.id, tx);
        const ids = body.optionIds.map((id) => id.toLowerCase()).sort();
        if (
          !ids.length ||
          new Set(ids).size !== ids.length ||
          (poll.selection_mode === 'single' && ids.length !== 1) ||
          ids.some((id) => !options.some((option) => option.id === id))
        )
          throw new ApplicationError('POLL_OPTIONS_INVALID');
        const id = randomUUID();
        const rows = await tx.query<{ created_at: Date }>(
          'INSERT INTO whaleu_community.poll_ballots(id,poll_id,account_id) VALUES ($1,$2,$3) ON CONFLICT(poll_id,account_id) DO NOTHING RETURNING created_at',
          [id, poll.id, actor],
        );
        if (!rows.rows[0]) throw new ApplicationError('POLL_ALREADY_VOTED');
        for (const optionId of ids)
          await tx.query(
            'INSERT INTO whaleu_community.poll_selections(ballot_id,poll_id,option_id) VALUES ($1,$2,$3)',
            [id, poll.id, optionId],
          );
        await this.community.event(
          `poll-ballot:${id}:cast`,
          'poll_ballot_cast',
          id,
          tx,
        );
        return {
          resourceId: id,
          createdAt: rows.rows[0].created_at.toISOString(),
        };
      },
    );
  }
}
