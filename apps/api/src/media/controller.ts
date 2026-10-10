import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import {
  mediaIdSchema,
  mediaIntentStatusSchema,
  mediaVariantSchema,
  prepareMediaSchema,
} from './contracts.js';
import type { MediaVariantName } from './contracts.js';
import { MEDIA_APPLICATION } from './application.js';
import type { MediaApplication } from './application.js';
import {
  MediaErrorResponses,
  MediaPrivateResponse,
  mediaBinaryResponseHeaders,
  mediaResponseHeaders,
} from './openapi.js';
const empty = z.strictObject({});
@ApiTags('Authenticated media')
@ApiBearerAuth('accessToken')
@MediaErrorResponses()
@Controller('v1/media')
export class MediaController {
  constructor(
    @Inject(MEDIA_APPLICATION) private readonly media: MediaApplication,
  ) {}
  @Post('upload-intents')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'prepareMediaUploadIntent',
    description:
      'Prepare a single Community post-image intent (JPEG/PNG, at most 5 MiB). Declaration is untrusted; current authority and immutable measured bytes decide readiness. Default runtime returns MEDIA_UNAVAILABLE.',
  })
  @ApiOkResponse({
    description: 'Strict upload intent status; only ready includes assetId.',
    standardSchema: mediaIntentStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: string | undefined,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: Record<string, never>,
    @Body({
      schema: prepareMediaSchema,
      pipes: [new SchemaValidationPipe(prepareMediaSchema)],
    })
    body: unknown,
  ) {
    return this.media.prepare(bearerToken(auth), body);
  }
  @Get('upload-intents/:id')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readMediaUploadIntent',
    description:
      'Read the current owner-scoped status union. Only ready includes assetId; ready does not grant parent binding or read authorization.',
  })
  @ApiOkResponse({
    description: 'Strict upload intent status; only ready includes assetId.',
    standardSchema: mediaIntentStatusSchema,
    headers: mediaResponseHeaders,
  })
  status(
    @Headers('authorization') auth: string | undefined,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: Record<string, never>,
    @Param('id', {
      schema: mediaIdSchema,
      pipes: [new SchemaValidationPipe(mediaIdSchema)],
    })
    id: string,
  ) {
    return this.media.status(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/finalize')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'finalizeMediaUploadIntent',
    description:
      'Finalize the exact immutable upload under current owner authority. Empty JSON object required; no client manifest, URL or storage locator is accepted.',
  })
  @ApiOkResponse({
    description: 'Strict upload intent status; only ready includes assetId.',
    standardSchema: mediaIntentStatusSchema,
    headers: mediaResponseHeaders,
  })
  finalize(
    @Headers('authorization') auth: string | undefined,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: Record<string, never>,
    @Param('id', {
      schema: mediaIdSchema,
      pipes: [new SchemaValidationPipe(mediaIdSchema)],
    })
    id: string,
    @Body({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _body: unknown,
  ) {
    return this.media.finalize(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/cancel')
  @HttpCode(204)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'cancelMediaUploadIntent',
    description:
      'Cancel the owner-scoped upload intent. Empty JSON object required; cancellation does not expose or authorize stored objects.',
  })
  @ApiNoContentResponse({
    description: 'Intent cancelled; no response body.',
    headers: mediaResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: string | undefined,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: Record<string, never>,
    @Param('id', {
      schema: mediaIdSchema,
      pipes: [new SchemaValidationPipe(mediaIdSchema)],
    })
    id: string,
    @Body({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _body: unknown,
  ) {
    return this.media.cancel(bearerToken(auth), id);
  }
  @Get('bindings/:id/:variant')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readAuthenticatedMediaVariant',
    description:
      'Stream a current-authorized binding variant (thumb-v1 or display-v1) as fixed JPEG/PNG bytes. No original, public URL, signed read URL, redirect or Range support. Range returns 503 MEDIA_UNAVAILABLE. The v1 authenticated-media attachment descriptor identifies asset/binding only and never grants access.',
  })
  @ApiOkResponse({
    description:
      'Authenticated canonical image bytes; never JSON or a redirect.',
    content: {
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
      'image/png': { schema: { type: 'string', format: 'binary' } },
    },
    headers: mediaBinaryResponseHeaders,
  })
  async download(
    @Headers('authorization') auth: string | undefined,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: Record<string, never>,
    @Headers('range') range: string | undefined,
    @Param('id', {
      schema: mediaIdSchema,
      pipes: [new SchemaValidationPipe(mediaIdSchema)],
    })
    id: string,
    @Param('variant', {
      schema: mediaVariantSchema,
      pipes: [new SchemaValidationPipe(mediaVariantSchema)],
    })
    variant: MediaVariantName,
    @Res() response: Response,
  ): Promise<void> {
    const opened = await this.media.open(bearerToken(auth), id, variant, range);
    response.once('close', opened.abort);
    try {
      for (const [key, value] of Object.entries(opened.headers))
        response.setHeader(key, value);
      await pipeline(opened.stream, response);
    } finally {
      opened.abort();
    }
  }
}
