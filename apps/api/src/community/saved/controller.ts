import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { idSchema, requestIdSchema } from '../contracts.js';
import {
  emptySavedQuerySchema,
  saveRequestSchema,
  savedPageQuerySchema,
  savedStatusSchema,
  updateChannelSchema,
  updatePreferenceSchema,
} from './contracts.js';
import type { SavedPageQuery, UpdateChannel } from './contracts.js';
import { SavedMutationService } from './mutation.service.js';
import { SavedReadService } from './read.service.js';
@Controller('v1/community/posts')
export class SavedController {
  constructor(
    @Inject(SavedMutationService)
    private readonly mutations: SavedMutationService,
    @Inject(SavedReadService) private readonly reads: SavedReadService,
  ) {}
  @Put(':postId/save') save(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(emptySavedQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(saveRequestSchema))
    body: { clientRequestId: string },
  ) {
    return this.mutations.set(bearerToken(auth), body.clientRequestId, {
      operation: 'set_post_saved',
      postId: id,
      desired: true,
      channel: null,
    });
  }
  @Delete(':postId/save') unsave(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(emptySavedQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(saveRequestSchema))
    body: { clientRequestId: string },
  ) {
    return this.mutations.set(bearerToken(auth), body.clientRequestId, {
      operation: 'set_post_saved',
      postId: id,
      desired: false,
      channel: null,
    });
  }
  @Get(':postId/update-preferences') preferences(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(emptySavedQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.reads.preferences(bearerToken(auth), id);
  }
  @Put(':postId/update-preferences') setPreference(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(emptySavedQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(updatePreferenceSchema))
    body: { clientRequestId: string; channel: UpdateChannel; enabled: boolean },
  ) {
    return this.mutations.set(bearerToken(auth), body.clientRequestId, {
      operation: 'set_post_update_preference',
      postId: id,
      desired: body.enabled,
      channel: body.channel,
    });
  }
}
@Controller('v1/me/community')
export class SavedRecoveryController {
  constructor(
    @Inject(SavedMutationService)
    private readonly mutations: SavedMutationService,
    @Inject(SavedReadService) private readonly reads: SavedReadService,
  ) {}
  @Get('saved') list(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(savedPageQuerySchema))
    query: SavedPageQuery,
  ) {
    return this.reads.list(bearerToken(auth), query);
  }
  @Post('saved/status') @HttpCode(200) status(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptySavedQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(savedStatusSchema))
    body: { postIds: string[] },
  ) {
    return this.reads.status(bearerToken(auth), body.postIds);
  }
  @Get('saved-requests/:requestId') receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(requestIdSchema)) id: string,
    @Query(new SchemaValidationPipe(emptySavedQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.mutations.receipt(bearerToken(auth), id);
  }
  @Delete('saved/:postId') cleanupSave(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(emptySavedQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(saveRequestSchema))
    body: { clientRequestId: string },
  ) {
    return this.mutations.set(
      bearerToken(auth),
      body.clientRequestId,
      {
        operation: 'set_post_saved',
        postId: id,
        desired: false,
        channel: null,
      },
      true,
    );
  }
  @Delete('post-update-preferences/:postId/:channel') cleanupPreference(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
    @Param('channel', new SchemaValidationPipe(updateChannelSchema))
    channel: UpdateChannel,
    @Query(new SchemaValidationPipe(emptySavedQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(saveRequestSchema))
    body: { clientRequestId: string },
  ) {
    return this.mutations.set(
      bearerToken(auth),
      body.clientRequestId,
      {
        operation: 'set_post_update_preference',
        postId: id,
        desired: false,
        channel,
      },
      true,
    );
  }
}
