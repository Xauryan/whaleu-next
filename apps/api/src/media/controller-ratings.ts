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
  RATINGS_TARGET_MEDIA_OWNER,
  RatingsTargetUploadApplication,
} from './application-ratings.js';
import type { RatingsTargetMediaOwner } from './application-ratings.js';
import { ApplicationError } from '../http/application-error.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { mediaVariantSchema } from './contracts.js';
import type { MediaVariantName } from './contracts.js';
import {
  cancelRatingsMediaRequestSchema,
  ratingsMediaCancelSchema,
  ratingsMediaGrantSchema,
  ratingsMediaRecoverySchema,
  ratingsMediaStatusSchema,
  ratingsMediaUploadObservedSchema,
  prepareRatingsMediaSchema,
} from './contracts-ratings.js';
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
export class RatingsTargetMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(RatingsTargetUploadApplication)
    upload: RatingsTargetUploadApplication,
    @Inject(RATINGS_TARGET_MEDIA_OWNER) owner: RatingsTargetMediaOwner,
  ) {
    super(upload, owner.runtime?.ingressStorage ?? null);
  }
}
const contextQuery = z.strictObject({
  contextId: mediaV2IdSchema,
  contextToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
@ApiTags('Authenticated media')
@ApiBearerAuth('accessToken')
@MediaErrorResponses()
@Controller('v3/media/ratings-target')
export class RatingsTargetMediaController {
  constructor(
    @Inject(RatingsTargetUploadApplication)
    private readonly media: RatingsTargetUploadApplication,
    @Inject(RATINGS_TARGET_MEDIA_OWNER)
    private readonly owner: RatingsTargetMediaOwner,
  ) {}
  @Post('upload-scopes')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'prepareMediaUploadIntentRatingsTarget',
    description:
      'Immutable single-image intent with exact original-byte digest. Default runtime unavailable.',
  })
  @ApiOkResponse({
    standardSchema: ratingsMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Body({
      schema: prepareRatingsMediaSchema,
      pipes: [new SchemaValidationPipe(prepareRatingsMediaSchema)],
    })
    body: unknown,
  ) {
    return this.media.prepare(bearerToken(auth), body);
  }
  @Get('upload-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'recoverMediaUploadRequestRatingsTarget',
    description:
      'Original authenticated actor receipt-only recovery. Does not grant content read authority.',
  })
  @ApiOkResponse({
    standardSchema: ratingsMediaRecoverySchema,
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
    operationId: 'cancelMediaUploadRequestRatingsTarget',
    description:
      'Original actor cancellation fence prevents a late prepare, including when no intent is recorded yet.',
  })
  @ApiOkResponse({
    standardSchema: ratingsMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelRequest(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
    @Body({
      schema: cancelRatingsMediaRequestSchema,
      pipes: [new SchemaValidationPipe(cancelRatingsMediaRequestSchema)],
    })
    body: unknown,
  ) {
    return this.media.cancelRequest(bearerToken(auth), id, body);
  }
  @Get('upload-scopes/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readMediaUploadIntentRatingsTarget' })
  @ApiOkResponse({
    standardSchema: ratingsMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  status(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
  ) {
    return this.media.status(bearerToken(auth), id);
  }
  @Post('upload-scopes/:id/grant')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'grantMediaUploadRatingsTarget',
    description:
      'Current-session, generation and deadline bound first-party multipart grant. No URL or bearer capability.',
  })
  @ApiOkResponse({
    standardSchema: ratingsMediaGrantSchema,
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
  @Post('upload-scopes/:id/uploads/:grantId')
  @HttpCode(200)
  @MediaPrivateResponse()
  @UseInterceptors(RatingsTargetMultipartInterceptor)
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
    operationId: 'uploadMediaMultipartRatingsTarget',
    description:
      'Exactly one file part named file, no fields/query. Admission precedes native Multer parsing. Complete multipart and full wire budget are required before observation.',
  })
  @ApiOkResponse({
    standardSchema: ratingsMediaUploadObservedSchema,
    headers: mediaResponseHeaders,
  })
  upload(
    @Req() request: Request,
    @Param('id', idOptions) id: string,
    @Param('grantId', idOptions) _grantId: string,
    @Query(emptyOptions) _query: Record<string, never>,
  ) {
    return this.media.observed(id, observedMultipart(request));
  }
  @Post('upload-scopes/:id/finalize')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'finalizeMediaUploadIntentRatingsTarget' })
  @ApiOkResponse({
    standardSchema: ratingsMediaStatusSchema,
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
  @Post('upload-scopes/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'cancelMediaUploadIntentRatingsTarget',
    description:
      'Returns logical terminal or historical binding independently of physical cleanup. Detached bindings also belong to owner deletion.',
  })
  @ApiOkResponse({
    standardSchema: ratingsMediaCancelSchema,
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
  @Get('targets/:targetId/appearances/:appearanceId/:variant')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readRatingsTargetCoverVariant',
    description:
      'Authenticated exact Ratings scope; two current authorization checks. No Range, redirect, original or public cache.',
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
      schema: contextQuery,
      pipes: [new SchemaValidationPipe(contextQuery)],
    })
    context: z.infer<typeof contextQuery>,
    @Param('targetId', idOptions) targetId: string,
    @Param('appearanceId', idOptions) appearanceId: string,
    @Param('variant', {
      schema: mediaVariantSchema,
      pipes: [new SchemaValidationPipe(mediaVariantSchema)],
    })
    variant: MediaVariantName,
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
    const result = await this.owner.delivery.open(
      token,
      {
        ...context,
        targetId,
        appearanceId,
        purpose: 'download',
        requestId: randomUUID(),
      },
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
