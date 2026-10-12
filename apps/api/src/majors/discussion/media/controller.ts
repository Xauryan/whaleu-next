import { MajorDiscussionMediaRequestGuard } from './request-guard.js';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import {
  majorDiscussionMediaStatusSchema,
  majorDiscussionMediaRecoverySchema,
  majorDiscussionMediaGrantSchema,
  majorDiscussionMediaUploadObservedSchema,
  majorDiscussionDescriptorSchema,
} from '../../../media/contracts-major-discussion.js';
import {
  mediaResponseHeaders,
  mediaBinaryResponseHeaders,
} from '../../../media/openapi.js';
const majorDiscussionEmptyBodySchema = z.preprocess(
  (v) => (v === undefined ? {} : v),
  z.strictObject({}),
);
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { bearerToken } from '../../../identity/tokens.js';
import { SchemaValidationPipe } from '../../../http/validation.js';
import {
  MediaMultipartInterceptor,
  observedMultipart,
} from '../../../media/multipart-ingress.js';
import {
  MediaPrivateResponse,
  MediaErrorResponses,
} from '../../../media/openapi.js';
import { mediaV2IdSchema } from '../../../media/contracts-v2.js';
import { mediaVariantSchema } from '../../../media/contracts.js';
import type { MediaVariantName } from '../../../media/contracts.js';
import {
  prepareMajorDiscussionMediaSchema,
  cancelMajorDiscussionMediaRequestSchema,
} from '../../../media/contracts-major-discussion.js';
import {
  MajorDiscussionMediaService,
  MAJOR_DISCUSSION_MEDIA_RUNTIME,
} from './facade.js';
import type { MajorDiscussionMediaRuntime } from './facade.js';
const readQuery = z.strictObject({
  ordinal: z
    .string()
    .regex(/^[0-2]$/)
    .transform(Number),
});
const readQueryOptions = {
  schema: readQuery,
  pipes: [new SchemaValidationPipe(readQuery)],
};
const empty = z.strictObject({});
const emptyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(empty)],
};
const emptyBodyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(majorDiscussionEmptyBodySchema)],
};
const idOptions = {
  schema: mediaV2IdSchema,
  pipes: [new SchemaValidationPipe(mediaV2IdSchema)],
};
const credential = bearerToken;
@Injectable()
export class MajorDiscussionMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(MajorDiscussionMediaService) media: MajorDiscussionMediaService,
    @Inject(MAJOR_DISCUSSION_MEDIA_RUNTIME)
    runtime: MajorDiscussionMediaRuntime | null,
  ) {
    super(media, runtime?.ingressStorage ?? null);
  }
}
@ApiTags('MajorDiscussion media')
@ApiBearerAuth('accessToken')
@MediaErrorResponses()
@UseGuards(MajorDiscussionMediaRequestGuard)
@Controller('v3/media/major-discussions')
export class MajorDiscussionMediaController {
  constructor(
    @Inject(MajorDiscussionMediaService)
    private readonly media: MajorDiscussionMediaService,
  ) {}
  @Post('upload-intents')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'prepareMajorDiscussionMedia' })
  @ApiOkResponse({
    standardSchema: majorDiscussionMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: prepareMajorDiscussionMediaSchema,
      pipes: [new SchemaValidationPipe(prepareMajorDiscussionMediaSchema)],
    })
    input: unknown,
  ) {
    return this.media.prepare(bearerToken(auth), input);
  }
  @Get('upload-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverMajorDiscussionMedia' })
  @ApiOkResponse({
    standardSchema: majorDiscussionMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  recover(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.recover(bearerToken(auth), id);
  }
  @Post('upload-requests/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'cancelMajorDiscussionMediaRequest' })
  @ApiOkResponse({
    standardSchema: majorDiscussionMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelRequest(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: cancelMajorDiscussionMediaRequestSchema,
      pipes: [
        new SchemaValidationPipe(cancelMajorDiscussionMediaRequestSchema),
      ],
    })
    input: unknown,
  ) {
    return this.media.cancelRequest(bearerToken(auth), id, input);
  }
  @Get('upload-intents/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readMajorDiscussionMediaStatus' })
  @ApiOkResponse({
    standardSchema: majorDiscussionMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  status(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.status(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/grant')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'grantMajorDiscussionMedia' })
  @ApiOkResponse({
    standardSchema: majorDiscussionMediaGrantSchema,
    headers: mediaResponseHeaders,
  })
  grant(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.grant(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/uploads/:grantId')
  @HttpCode(200)
  @MediaPrivateResponse()
  @UseInterceptors(MajorDiscussionMultipartInterceptor)
  @ApiOperation({ operationId: 'uploadMajorDiscussionMedia' })
  @ApiOkResponse({
    standardSchema: majorDiscussionMediaUploadObservedSchema,
    headers: mediaResponseHeaders,
  })
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
  upload(
    @Req() request: Request,
    @Param('id', idOptions) _id: string,
    @Param('grantId', idOptions) _grant: string,
    @Query(emptyOptions) _query: unknown,
  ) {
    return this.media.observed(observedMultipart(request));
  }
  @Post('upload-intents/:id/finalize')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'finalizeMajorDiscussionMedia' })
  @ApiOkResponse({
    standardSchema: majorDiscussionMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  finalize(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.finalize(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'cancelMajorDiscussionMedia' })
  @ApiOkResponse({
    standardSchema: majorDiscussionMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.cancel(bearerToken(auth), id);
  }
  @Get('majors/:majorId/comments/:commentId/bindings/:bindingId')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readMajorDiscussionMediaDescriptor' })
  @ApiOkResponse({
    standardSchema: majorDiscussionDescriptorSchema,
    headers: mediaResponseHeaders,
  })
  descriptor(
    @Headers('authorization') auth: unknown,
    @Param('majorId', idOptions) majorId: string,
    @Param('commentId', idOptions) commentId: string,
    @Param('bindingId', idOptions) bindingId: string,
    @Query(readQueryOptions) query: z.infer<typeof readQuery>,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.descriptor(credential(auth), {
      majorId,
      commentId,
      bindingId,
      ordinal: query.ordinal,
    });
  }
  @Get('majors/:majorId/comments/:commentId/bindings/:bindingId/:variant')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readMajorDiscussionMediaVariant',
    description:
      'Exact current Major source, root, publication Review and complete ordered image-set Safety proof before and after opening immutable derived bytes. No original, redirect, public URL or Range.',
  })
  @ApiOkResponse({
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
    },
    headers: mediaBinaryResponseHeaders,
  })
  async open(
    @Headers('authorization') auth: unknown,
    @Headers('range') range: string | undefined,
    @Param('majorId', idOptions) majorId: string,
    @Param('commentId', idOptions) commentId: string,
    @Param('bindingId', idOptions) bindingId: string,
    @Param('variant', {
      schema: mediaVariantSchema,
      pipes: [new SchemaValidationPipe(mediaVariantSchema)],
    })
    variant: MediaVariantName,
    @Query(readQueryOptions) query: z.infer<typeof readQuery>,
    @Body(emptyBodyOptions) _body: unknown,
    @Res() response: Response,
  ) {
    const result = await this.media.open(
      credential(auth),
      {
        majorId,
        commentId,
        bindingId,
        ordinal: query.ordinal,
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
