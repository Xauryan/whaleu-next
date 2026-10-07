import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { bearerToken } from '../../identity/tokens.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import { idSchema, requestIdSchema } from '../contracts.js';
import { ballotSchema, emptyPollQuerySchema } from './contracts.js';
import type { CastBallot } from './contracts.js';
import { PollReadService } from './poll-read.service.js';
import { PollVotingService } from './poll-voting.service.js';
import { BallotRequestsRepository } from './ballot-requests.repository.js';
@Controller('v1/community/posts')
export class PollController {
  constructor(
    @Inject(PollReadService) private readonly polls: PollReadService,
    @Inject(PollVotingService) private readonly votes: PollVotingService,
  ) {}
  @Get(':postId/poll') read(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyPollQuerySchema))
    _query: Record<string, never>,
    @Param('postId', new SchemaValidationPipe(idSchema)) postId: string,
  ) {
    return this.polls.get(bearerToken(auth), postId);
  }
  @Post(':postId/poll/ballots') cast(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyPollQuerySchema))
    _query: Record<string, never>,
    @Param('postId', new SchemaValidationPipe(idSchema)) postId: string,
    @Body(new SchemaValidationPipe(ballotSchema)) body: CastBallot,
  ) {
    return this.votes.cast(bearerToken(auth), postId, body);
  }
}
@Controller('v1/me/community')
export class PollRecoveryController {
  constructor(
    @Inject(PollReadService) private readonly polls: PollReadService,
    @Inject(BallotRequestsRepository)
    private readonly requests: BallotRequestsRepository,
  ) {}
  @Get('poll-requests/:requestId') receipt(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyPollQuerySchema))
    _query: Record<string, never>,
    @Param('requestId', new SchemaValidationPipe(requestIdSchema))
    requestId: string,
  ) {
    return this.requests.receipt(bearerToken(auth), requestId);
  }
  @Get('poll-ballots/:postId') own(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyPollQuerySchema))
    _query: Record<string, never>,
    @Param('postId', new SchemaValidationPipe(idSchema)) postId: string,
  ) {
    return this.polls.own(bearerToken(auth), postId);
  }
}
