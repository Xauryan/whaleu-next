import { PrivateMessageMediaRequestGuard } from './request-guard.js';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import {
  privateMessageMediaStatusSchema,
  privateMessageMediaRecoverySchema,
  privateMessageMediaGrantSchema,
  privateMessageMediaUploadObservedSchema,
  privateMessageDescriptorSchema,
} from '../../media/contracts-private-message.js';
import {
  mediaResponseHeaders,
  mediaBinaryResponseHeaders,
} from '../../media/openapi.js';
const privateMessageEmptyBodySchema = z.preprocess(
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
import { bearerToken } from '../../identity/tokens.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  MediaMultipartInterceptor,
  observedMultipart,
} from '../../media/multipart-ingress.js';
import {
  MediaPrivateResponse,
  MediaErrorResponses,
} from '../../media/openapi.js';
import { mediaV2IdSchema } from '../../media/contracts-v2.js';
import { mediaVariantSchema } from '../../media/contracts.js';
import type { MediaVariantName } from '../../media/contracts.js';
import {
  preparePrivateMessageMediaSchema,
  cancelPrivateMessageMediaRequestSchema,
} from '../../media/contracts-private-message.js';
import {
  PrivateMessageMediaService,
  PRIVATE_MESSAGE_MEDIA_RUNTIME,
} from './facade.js';
import type { PrivateMessageMediaRuntime } from './facade.js';
const empty = z.strictObject({});
const emptyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(empty)],
};
const emptyBodyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(privateMessageEmptyBodySchema)],
};
const idOptions = {
  schema: mediaV2IdSchema,
  pipes: [new SchemaValidationPipe(mediaV2IdSchema)],
};
const credential = bearerToken;
@Injectable()
export class PrivateMessageMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(PrivateMessageMediaService) media: PrivateMessageMediaService,
    @Inject(PRIVATE_MESSAGE_MEDIA_RUNTIME)
    runtime: PrivateMessageMediaRuntime | null,
  ) {
    super(media, runtime?.ingressStorage ?? null);
  }
}
@ApiTags('PrivateMessage media')
@ApiBearerAuth('accessToken')
@MediaErrorResponses()
@UseGuards(PrivateMessageMediaRequestGuard)
@Controller('v3/media/private-messages')
export class PrivateMessageMediaController {
  constructor(
    @Inject(PrivateMessageMediaService)
    private readonly media: PrivateMessageMediaService,
  ) {}
  @Post('upload-intents')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'preparePrivateMessageMedia' })
  @ApiOkResponse({
    standardSchema: privateMessageMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: preparePrivateMessageMediaSchema,
      pipes: [new SchemaValidationPipe(preparePrivateMessageMediaSchema)],
    })
    input: unknown,
  ) {
    return this.media.prepare(bearerToken(auth), input);
  }
  @Get('upload-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverPrivateMessageMedia' })
  @ApiOkResponse({
    standardSchema: privateMessageMediaRecoverySchema,
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
  @ApiOperation({ operationId: 'cancelPrivateMessageMediaRequest' })
  @ApiOkResponse({
    standardSchema: privateMessageMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelRequest(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: cancelPrivateMessageMediaRequestSchema,
      pipes: [new SchemaValidationPipe(cancelPrivateMessageMediaRequestSchema)],
    })
    input: unknown,
  ) {
    return this.media.cancelRequest(bearerToken(auth), id, input);
  }
  @Get('upload-intents/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readPrivateMessageMediaStatus' })
  @ApiOkResponse({
    standardSchema: privateMessageMediaStatusSchema,
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
  @ApiOperation({ operationId: 'grantPrivateMessageMedia' })
  @ApiOkResponse({
    standardSchema: privateMessageMediaGrantSchema,
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
  @UseInterceptors(PrivateMessageMultipartInterceptor)
  @ApiOperation({ operationId: 'uploadPrivateMessageMedia' })
  @ApiOkResponse({
    standardSchema: privateMessageMediaUploadObservedSchema,
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
  @ApiOperation({ operationId: 'finalizePrivateMessageMedia' })
  @ApiOkResponse({
    standardSchema: privateMessageMediaStatusSchema,
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
  @ApiOperation({ operationId: 'cancelPrivateMessageMedia' })
  @ApiOkResponse({
    standardSchema: privateMessageMediaStatusSchema,
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
  @Get('conversations/:conversationId/messages/:messageId')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readPrivateMessageMediaDescriptor' })
  @ApiOkResponse({
    standardSchema: privateMessageDescriptorSchema,
    headers: mediaResponseHeaders,
  })
  descriptor(
    @Headers('authorization') auth: unknown,
    @Param('conversationId', idOptions) conversationId: string,
    @Param('messageId', idOptions) messageId: string,
    @Query(emptyOptions) _query: unknown,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.descriptor(credential(auth), {
      conversationId,
      messageId,
    });
  }
  @Get(
    'conversations/:conversationId/messages/:messageId/bindings/:bindingId/:variant',
  )
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readPrivateMessageMediaVariant',
    description:
      'Exact current private message and image Safety proof; authenticated business reads, no redirect or public cache. Only the exact current private message image is served.',
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
    @Param('conversationId', idOptions) conversationId: string,
    @Param('messageId', idOptions) messageId: string,
    @Param('bindingId', idOptions) bindingId: string,
    @Param('variant', {
      schema: mediaVariantSchema,
      pipes: [new SchemaValidationPipe(mediaVariantSchema)],
    })
    variant: MediaVariantName,
    @Query(emptyOptions) _query: unknown,
    @Body(emptyBodyOptions) _body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const result = await this.media.open(
      credential(auth),
      {
        conversationId,
        messageId,
      },
      bindingId,
      variant,
      request.ip ?? request.socket.remoteAddress ?? 'shared-unknown',
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
