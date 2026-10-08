import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Put,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { idSchema, requestIdSchema } from '../contracts.js';
import { ReactionsService } from '../reactions.service.js';
import { postLikeIntentSchema } from './contracts.js';
import type { PostLikeIntent } from './contracts.js';

@Controller('v1/community/posts')
export class PostLikeController {
  constructor(
    @Inject(ReactionsService) private readonly reactions: ReactionsService,
  ) {}
  @Put(':postId/like') set(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) postId: string,
    @Body(new SchemaValidationPipe(postLikeIntentSchema))
    intent: PostLikeIntent,
  ) {
    return this.reactions.setLike(bearerToken(auth), postId, intent);
  }
}
@Controller('v1/me/community')
export class PostLikeRecoveryController {
  constructor(
    @Inject(ReactionsService) private readonly reactions: ReactionsService,
  ) {}
  @Get('post-like-requests/:requestId') receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(requestIdSchema))
    requestId: string,
  ) {
    return this.reactions.receipt(bearerToken(auth), requestId);
  }
}
