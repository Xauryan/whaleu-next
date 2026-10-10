import {
  ratingsDiscussionBatchCancelRequestSchema,
  ratingsDiscussionBatchIdentitySchema,
  ratingsDiscussionBatchStatusSchema,
  ratingsDiscussionBatchRecoverySchema,
  ratingsDiscussionSealSchema,
  ratingsDiscussionBatchMutationSchema,
  ratingsDiscussionRemoveMemberSchema,
} from './contracts-ratings-discussion.js';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Res,
  Param,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import {
  RATINGS_DISCUSSION_MEDIA_OWNER,
  RatingsDiscussionUploadApplication,
} from './application-ratings-discussion.js';
import type { RatingsDiscussionMediaOwner } from './application-ratings-discussion.js';
import { ApplicationError } from '../http/application-error.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import {
  ratingsDiscussionCancelRequestSchema,
  ratingsDiscussionMediaGrantSchema,
  ratingsDiscussionMemberRecoverySchema,
  ratingsDiscussionMemberStatusSchema,
  ratingsDiscussionMediaUploadObservedSchema,
  ratingsDiscussionMemberPrepareSchema,
} from './contracts-ratings-discussion.js';
import {
  MediaMultipartInterceptor,
  observedMultipart,
} from './multipart-ingress.js';
import {
  MediaErrorResponses,
  MediaPrivateResponse,
  mediaResponseHeaders,
  mediaBinaryResponseHeaders,
} from './openapi.js';
const empty = z.strictObject({});
const idOptions = {
  schema: mediaV2IdSchema,
  pipes: [new SchemaValidationPipe(mediaV2IdSchema)],
};
const emptyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(empty)],
};
@Injectable()
export class RatingsDiscussionMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(RatingsDiscussionUploadApplication)
    upload: RatingsDiscussionUploadApplication,
    @Inject(RATINGS_DISCUSSION_MEDIA_OWNER) owner: RatingsDiscussionMediaOwner,
  ) {
    super(upload, owner.runtime?.ingressStorage ?? null);
  }
}
const deliveryQuery = z
  .strictObject({
    protocol: z.literal('ratings-discussion-media-v1'),
    targetId: mediaV2IdSchema,
    rootId: mediaV2IdSchema,
    replyId: z
      .union([mediaV2IdSchema, z.literal('null')])
      .transform((v) => (v === 'null' ? null : v)),
    subjectRevision: mediaV2IdSchema,
    contextId: mediaV2IdSchema,
    contextToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    bindingId: mediaV2IdSchema,
    ordinal: z.coerce.number().int().min(0).max(8),
    attachmentSetDigest: z.string().regex(/^[a-f0-9]{64}$/),
    variant: z.enum(['thumb-v1', 'display-v1']),
  })
  .refine(
    (v) => v.replyId === null || (v.ordinal < 3 && v.replyId !== v.rootId),
  );
@ApiTags('Authenticated media')
@ApiBearerAuth('accessToken')
@MediaErrorResponses()
@Controller('v3/media/ratings-discussion')
export class RatingsDiscussionMediaController {
  constructor(
    @Inject(RatingsDiscussionUploadApplication)
    private readonly media: RatingsDiscussionUploadApplication,
    @Inject(RATINGS_DISCUSSION_MEDIA_OWNER)
    private readonly owner: RatingsDiscussionMediaOwner,
  ) {}
  @Post('batches')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'prepareRatingsDiscussionMediaBatch' })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionBatchStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepareBatch(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Body({
      schema: ratingsDiscussionBatchIdentitySchema,
      pipes: [new SchemaValidationPipe(ratingsDiscussionBatchIdentitySchema)],
    })
    body: unknown,
  ) {
    return this.media.prepareBatch(bearerToken(auth), body);
  }
  @Get('batch-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverRatingsDiscussionMediaBatch' })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionBatchRecoverySchema,
    headers: mediaResponseHeaders,
  })
  recoverBatch(
    @Headers('authorization') auth: string | undefined,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: Record<string, never>,
  ) {
    return this.media.recoverBatch(bearerToken(auth), id);
  }
  @Post('batch-requests/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'cancelRatingsDiscussionMediaBatchRequest' })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionBatchRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelBatchRequest(
    @Headers('authorization') auth: string | undefined,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: Record<string, never>,
    @Body({
      schema: ratingsDiscussionBatchCancelRequestSchema,
      pipes: [
        new SchemaValidationPipe(ratingsDiscussionBatchCancelRequestSchema),
      ],
    })
    body: unknown,
  ) {
    return this.media.cancelBatchRequest(bearerToken(auth), id, body);
  }
  @Get('batches/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readRatingsDiscussionMediaBatch' })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionBatchStatusSchema,
    headers: mediaResponseHeaders,
  })
  batchStatus(
    @Headers('authorization') auth: string | undefined,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: Record<string, never>,
  ) {
    return this.media.batchStatus(bearerToken(auth), id);
  }
  @Post('batches/:id/seal')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'sealRatingsDiscussionMediaBatch' })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionBatchStatusSchema,
    headers: mediaResponseHeaders,
  })
  seal(
    @Headers('authorization') auth: string | undefined,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: Record<string, never>,
    @Body({
      schema: ratingsDiscussionSealSchema,
      pipes: [new SchemaValidationPipe(ratingsDiscussionSealSchema)],
    })
    body: z.infer<typeof ratingsDiscussionSealSchema>,
  ) {
    if (body.batchId !== id)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    return this.media.seal(bearerToken(auth), body);
  }
  @Post('batches/:id/remove')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'removeRatingsDiscussionMediaMember' })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionBatchStatusSchema,
    headers: mediaResponseHeaders,
  })
  remove(
    @Headers('authorization') auth: string | undefined,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: Record<string, never>,
    @Body({
      schema: ratingsDiscussionRemoveMemberSchema,
      pipes: [new SchemaValidationPipe(ratingsDiscussionRemoveMemberSchema)],
    })
    body: unknown,
  ) {
    return this.media.remove(bearerToken(auth), id, body);
  }
  @Post('batches/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'cancelRatingsDiscussionMediaBatch' })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionBatchStatusSchema,
    headers: mediaResponseHeaders,
  })
  cancelBatch(
    @Headers('authorization') auth: string | undefined,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: Record<string, never>,
    @Body({
      schema: ratingsDiscussionBatchMutationSchema,
      pipes: [new SchemaValidationPipe(ratingsDiscussionBatchMutationSchema)],
    })
    body: unknown,
  ) {
    return this.media.cancelBatch(bearerToken(auth), id, body);
  }
  @Post('members')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'prepareMediaUploadIntentRatingsDiscussion',
    description:
      'Immutable discussion member intent with exact original-byte digest. Default runtime unavailable.',
  })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionMemberStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Body({
      schema: ratingsDiscussionMemberPrepareSchema,
      pipes: [new SchemaValidationPipe(ratingsDiscussionMemberPrepareSchema)],
    })
    body: unknown,
  ) {
    return this.media.prepare(bearerToken(auth), body);
  }
  @Get('upload-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'recoverMediaUploadRequestRatingsDiscussion',
    description:
      'Original authenticated actor receipt-only recovery. Does not grant content read authority.',
  })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionMemberRecoverySchema,
    headers: mediaResponseHeaders,
  })
  recover(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
  ) {
    return this.media.recover(bearerToken(auth), id);
  }
  @Post('upload-requests/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'cancelMediaUploadRequestRatingsDiscussion',
    description:
      'Original actor cancellation fence prevents a late prepare, including when no intent is recorded yet.',
  })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionMemberRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelRequest(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
    @Body({
      schema: ratingsDiscussionCancelRequestSchema,
      pipes: [new SchemaValidationPipe(ratingsDiscussionCancelRequestSchema)],
    })
    body: unknown,
  ) {
    return this.media.cancelRequest(bearerToken(auth), id, body);
  }
  @Get('members/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readMediaUploadIntentRatingsDiscussion' })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionMemberStatusSchema,
    headers: mediaResponseHeaders,
  })
  status(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
  ) {
    return this.media.status(bearerToken(auth), id);
  }
  @Post('members/:id/grant')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'grantMediaUploadRatingsDiscussion',
    description:
      'Current-session, generation and deadline bound first-party multipart grant. No URL or bearer capability.',
  })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionMediaGrantSchema,
    headers: mediaResponseHeaders,
  })
  grant(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.grant(bearerToken(auth), id);
  }
  @Post('members/:id/uploads/:grantId')
  @HttpCode(200)
  @MediaPrivateResponse()
  @UseInterceptors(RatingsDiscussionMultipartInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    operationId: 'uploadMediaMultipartRatingsDiscussion',
    description:
      'Exactly one file part named file, no fields/query. Admission precedes native Multer parsing. Complete multipart and full wire budget are required before observation.',
  })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionMediaUploadObservedSchema,
    headers: mediaResponseHeaders,
  })
  upload(
    @Req() request: Request,
    @Param('id', idOptions) id: string,
    @Param('grantId', idOptions) _grantId: string,
    @Query(emptyOptions) _query: Record<string, never>,
  ) {
    return this.media.observed(
      bearerToken(request.headers.authorization),
      id,
      observedMultipart(request),
    );
  }
  @Post('members/:id/finalize')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'finalizeMediaUploadIntentRatingsDiscussion' })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionMemberStatusSchema,
    headers: mediaResponseHeaders,
  })
  finalize(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.finalize(bearerToken(auth), id);
  }
  @Post('members/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'cancelMediaUploadIntentRatingsDiscussion',
    description:
      'Returns logical terminal or historical binding independently of physical cleanup. Detached bindings also belong to owner deletion.',
  })
  @ApiOkResponse({
    standardSchema: ratingsDiscussionMemberStatusSchema,
    headers: mediaResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.cancel(bearerToken(auth), id);
  }
  @Get('images')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readRatingsDiscussionImageVariant',
    description:
      'Authenticated Ratings whole-set authorization, checked twice. No Range, redirect, original or public cache.',
  })
  @ApiOkResponse({
    content: {
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
      'image/png': { schema: { type: 'string', format: 'binary' } },
    },
    headers: mediaBinaryResponseHeaders,
  })
  async open(
    @Headers('authorization') auth: unknown,
    @Headers('range') range: string | undefined,
    @Query({
      schema: deliveryQuery,
      pipes: [new SchemaValidationPipe(deliveryQuery)],
    })
    query: z.infer<typeof deliveryQuery>,
    @Res() response: Response,
  ): Promise<void> {
    const token = bearerToken(auth);
    if (!this.owner.delivery) {
      await this.owner.authorized(
        token,
        async () => {
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        },
        false,
      );
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    }
    const {
      protocol: _protocol,
      bindingId,
      ordinal,
      variant,
      ...context
    } = query;
    void _protocol;
    const result = await this.owner.delivery.open(
      token,
      { ...context, purpose: 'download', requestId: randomUUID() },
      bindingId,
      ordinal,
      variant,
      range,
    );
    response.once('close', result.abort);
    try {
      for (const [name, value] of Object.entries(result.headers))
        response.setHeader(name, value);
      await pipeline(result.stream, response);
    } finally {
      result.abort();
    }
  }
}
