import { RatingScopedContextService } from './context.service.js';
import {
  RatingScopedRandomService,
  ratingScopedRandomQuerySchema,
  ratingTargetCoverRandomResponseSchema,
} from './random.service.js';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Header,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { bearerToken } from '../../identity/tokens.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import { RatingScopedCommands } from './commands.service.js';
import {
  RatingScopedReadService,
  ratingScopedPageContextSchema,
  ratingScopedTargetPageSchema,
  ratingScopedSubscriptionPageSchema,
} from './read.service.js';
import { ratingScopedEditContextSchema } from './controller.js';
import {
  ratingScopedReadQuerySchema,
  ratingScopedTargetQuerySchema,
  ratingScopedContextRequestSchema,
  ratingScopedPageQuerySchema,
  scopedId,
  scopedDigest,
} from './contracts.js';
import { ratingTimeSchema, ratingTargetSchema } from '../contracts.js';
import {
  ratingsMediaDescriptorSchema,
  prepareRatingsMediaSchema,
  ratingsMediaRecoverySchema,
} from '../../media/contracts-ratings.js';
import { RatingTargetCoverMediaService } from '../target-cover-media.service.js';
import {
  ratingTargetCoverContextSchema,
  ratingTargetCoverIntentSchema,
  ratingTargetCoverCommitSchema,
  ratingTargetCoverReceiptSchema,
  ratingTargetCoverPreparationSchema,
  ratingTargetCoverReferenceSchema,
  ratingTargetCoverUploadScopeSchema,
} from './target-cover-contracts.js';
const readPipe = new SchemaValidationPipe(ratingScopedReadQuerySchema);
const prepareResponse = z.union([
  ratingTargetCoverPreparationSchema,
  ratingTargetCoverReceiptSchema,
]);
const coveredTarget = ratingTargetSchema.extend({
  cover: ratingsMediaDescriptorSchema.nullable(),
});
export const ratingTargetCoverPageSchema =
  ratingScopedTargetPageSchema.safeExtend({
    items: z.array(coveredTarget).max(50),
  });
export const ratingTargetCoverSubscriptionPageSchema =
  ratingScopedSubscriptionPageSchema.safeExtend({
    items: z.array(coveredTarget).max(50),
  });
export const ratingTargetCoverUploadScopeResponseSchema = z.strictObject({
  protocolVersion: z.literal(3),
  scopeId: scopedId,
  scopeRevision: scopedDigest,
  targetId: scopedId,
  expiresAt: ratingTimeSchema,
  prepare: prepareRatingsMediaSchema,
});
export const ratingTargetCoverCancelScopeResponseSchema = z.strictObject({
  protocolVersion: z.literal(3),
  clientRequestId: scopedId,
  scopeId: scopedId,
  scopeRevision: scopedDigest,
  prepare: prepareRatingsMediaSchema,
  recovery: ratingsMediaRecoverySchema,
});
export const ratingTargetCoverCurrentSchema = z.strictObject({
  context: ratingScopedPageContextSchema,
  target: ratingTargetSchema,
  cover: ratingsMediaDescriptorSchema.nullable(),
});
@ApiTags('Ratings target cover')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v3/ratings/target-cover')
export class RatingTargetCoverController {
  constructor(
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedRandomService)
    private readonly random: RatingScopedRandomService,
    @Inject(RatingScopedCommands)
    private readonly commands: RatingScopedCommands,
    @Inject(RatingScopedReadService)
    private readonly reads: RatingScopedReadService,
    @Inject(RatingTargetCoverMediaService)
    private readonly media: RatingTargetCoverMediaService,
  ) {}
  @Post('contexts')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverContext' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingTargetCoverContextSchema,
  })
  context(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: ratingScopedContextRequestSchema,
      pipes: [new SchemaValidationPipe(ratingScopedContextRequestSchema)],
    })
    body: z.infer<typeof ratingScopedContextRequestSchema>,
  ) {
    return this.contexts.createCover(bearerToken(auth), body);
  }
  @Get('random-target')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverRandom' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingTargetCoverRandomResponseSchema,
  })
  randomTarget(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingScopedRandomQuerySchema,
      pipes: [new SchemaValidationPipe(ratingScopedRandomQuerySchema)],
    })
    query: z.infer<typeof ratingScopedRandomQuerySchema>,
  ) {
    return this.random.select(bearerToken(auth), query, 3);
  }
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverPrepare' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: prepareResponse,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: ratingTargetCoverIntentSchema,
      pipes: [new SchemaValidationPipe(ratingTargetCoverIntentSchema)],
    })
    body: z.infer<typeof ratingTargetCoverIntentSchema>,
  ) {
    return this.commands.prepare(bearerToken(auth), body);
  }
  @Post('commit')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverCommit' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingTargetCoverReceiptSchema,
  })
  commit(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: ratingTargetCoverCommitSchema,
      pipes: [new SchemaValidationPipe(ratingTargetCoverCommitSchema)],
    })
    body: z.infer<typeof ratingTargetCoverCommitSchema>,
  ) {
    const { preparationContextRevision, ...intent } = body;
    return this.commands.submit(
      bearerToken(auth),
      intent,
      preparationContextRevision,
    );
  }
  @Post('cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverCancel' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingTargetCoverReceiptSchema,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: ratingTargetCoverIntentSchema,
      pipes: [new SchemaValidationPipe(ratingTargetCoverIntentSchema)],
    })
    body: z.infer<typeof ratingTargetCoverIntentSchema>,
  ) {
    return this.commands.cancel(bearerToken(auth), body);
  }
  @Get('receipts/:id')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverReceipt' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingTargetCoverReceiptSchema,
  })
  async receipt(
    @Headers('authorization') auth: unknown,
    @Param('id', {
      schema: scopedId,
      pipes: [new SchemaValidationPipe(scopedId)],
    })
    id: string,
  ) {
    return ratingTargetCoverReceiptSchema.parse(
      await this.commands.status(bearerToken(auth), id),
    );
  }
  @Post('upload-scopes')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverUploadScope' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingTargetCoverUploadScopeResponseSchema,
  })
  uploadScope(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: ratingTargetCoverUploadScopeSchema,
      pipes: [new SchemaValidationPipe(ratingTargetCoverUploadScopeSchema)],
    })
    body: unknown,
  ) {
    return this.commands.prepareUploadScope(bearerToken(auth), body);
  }
  @Post('upload-scopes/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverUploadScopeCancel' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingTargetCoverCancelScopeResponseSchema,
  })
  cancelUploadScope(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: ratingTargetCoverUploadScopeSchema,
      pipes: [new SchemaValidationPipe(ratingTargetCoverUploadScopeSchema)],
    })
    body: unknown,
  ) {
    return this.commands.cancelUploadScope(bearerToken(auth), body);
  }
  @Get('targets/:id/edit-context')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverEditContext' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingScopedEditContextSchema.extend({
      cover: ratingTargetCoverReferenceSchema.nullable(),
    }),
  })
  editContext(
    @Headers('authorization') auth: unknown,
    @Param('id', {
      schema: scopedId,
      pipes: [new SchemaValidationPipe(scopedId)],
    })
    id: string,
    @Query({ schema: ratingScopedReadQuerySchema, pipes: [readPipe] })
    query: z.infer<typeof ratingScopedReadQuerySchema>,
  ) {
    return this.commands.editContext(bearerToken(auth), id, query, true);
  }
  @Get('targets/:id')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverCurrent' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingTargetCoverCurrentSchema,
  })
  target(
    @Headers('authorization') auth: unknown,
    @Param('id', {
      schema: scopedId,
      pipes: [new SchemaValidationPipe(scopedId)],
    })
    id: string,
    @Query({ schema: ratingScopedReadQuerySchema, pipes: [readPipe] })
    query: z.infer<typeof ratingScopedReadQuerySchema>,
  ) {
    return this.reads.target(bearerToken(auth), id, query, true);
  }
  @Get('targets')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverTargets' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingTargetCoverPageSchema,
  })
  targets(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingScopedTargetQuerySchema,
      pipes: [new SchemaValidationPipe(ratingScopedTargetQuerySchema)],
    })
    query: z.infer<typeof ratingScopedTargetQuerySchema>,
  ) {
    return this.reads.targets(bearerToken(auth), query, true);
  }
  @Get('subscriptions')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverSubscriptions' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingTargetCoverSubscriptionPageSchema,
  })
  subscriptions(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingScopedPageQuerySchema,
      pipes: [new SchemaValidationPipe(ratingScopedPageQuerySchema)],
    })
    query: z.infer<typeof ratingScopedPageQuerySchema>,
  ) {
    return this.reads.listSubscriptions(bearerToken(auth), query, true);
  }
  @Get('targets/:id/appearances/:appearanceId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetCoverDescriptor' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingsMediaDescriptorSchema,
  })
  descriptor(
    @Headers('authorization') auth: unknown,
    @Param('id', {
      schema: scopedId,
      pipes: [new SchemaValidationPipe(scopedId)],
    })
    id: string,
    @Param('appearanceId', {
      schema: scopedId,
      pipes: [new SchemaValidationPipe(scopedId)],
    })
    appearanceId: string,
    @Query({ schema: ratingScopedReadQuerySchema, pipes: [readPipe] })
    query: z.infer<typeof ratingScopedReadQuerySchema>,
  ) {
    return this.media.descriptor(bearerToken(auth), id, appearanceId, query);
  }
}
