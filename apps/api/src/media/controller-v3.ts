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
import type { Request } from 'express';
import { z } from 'zod';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { MEDIA_BATCH_APPLICATION } from './application-v3.js';
import type { MediaBatchApplication } from './application-v3.js';
import {
  mediaV2IdSchema,
  mediaGrantSchema,
  mediaUploadObservedSchema,
} from './contracts-v2.js';
import {
  mediaBatchIdentitySchema,
  mediaBatchLayoutSchema,
  mediaBatchSealSchema,
  mediaBatchReopenSchema,
  mediaBatchCancelSchema,
  mediaBatchRecoverPublicationSchema,
  mediaMemberPrepareSchema,
  mediaBatchStatusSchema,
  mediaBatchRecoverySchema,
  mediaBatchPublicationRecoverySchema,
  mediaMemberStatusSchema,
  mediaBatchFencePublicationSchema,
  mediaBatchFencePublicationResultSchema,
} from './contracts-v3.js';
import {
  MediaMultipartInterceptorV3,
  observedMultipart,
} from './multipart-ingress.js';
import {
  MediaErrorResponses,
  MediaPrivateResponse,
  mediaResponseHeaders,
} from './openapi.js';
const empty = z.strictObject({});
const options = <T extends z.ZodType>(schema: T) => ({
  schema,
  pipes: [new SchemaValidationPipe(schema)],
});
const idOptions = options(mediaV2IdSchema),
  emptyOptions = options(empty);
@ApiTags('Authenticated media')
@ApiBearerAuth('accessToken')
@MediaErrorResponses()
@Controller('v3/media')
export class MediaBatchController {
  constructor(
    @Inject(MEDIA_BATCH_APPLICATION)
    private readonly media: MediaBatchApplication,
  ) {}
  @Post('batches/prepare')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'prepareMediaPublicationBatchV3',
    description:
      'Immutable original actor/draft batch. Default runtime unavailable.',
  })
  @ApiOkResponse({
    standardSchema: mediaBatchStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Body(options(mediaBatchIdentitySchema)) body: unknown,
  ) {
    return this.media.prepareBatch(bearerToken(auth), body);
  }
  @Get('batches/requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverMediaPublicationBatchV3' })
  @ApiOkResponse({
    standardSchema: mediaBatchRecoverySchema,
    headers: mediaResponseHeaders,
  })
  recover(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return this.media.recoverBatch(bearerToken(auth), id);
  }
  @Post('batches/requests/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'cancelMediaPublicationBatchV3' })
  @ApiOkResponse({
    standardSchema: mediaBatchRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(options(mediaBatchCancelSchema)) body: unknown,
  ) {
    return this.media.cancelBatch(bearerToken(auth), id, body);
  }
  @Post('batches/recover-publication')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverMediaBatchPublicationV3' })
  @ApiOkResponse({
    standardSchema: mediaBatchPublicationRecoverySchema,
    headers: mediaResponseHeaders,
  })
  recoverPublication(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Body(options(mediaBatchRecoverPublicationSchema)) body: unknown,
  ) {
    return this.media.recoverPublication(bearerToken(auth), body);
  }
  @Post('batches/:id/fence-publication')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'fenceMediaBatchPublicationV3',
    description:
      'Explicit original actor cancellation creates a durable Community non-created fence. A created receipt wins.',
  })
  @ApiOkResponse({
    standardSchema: mediaBatchFencePublicationResultSchema,
    headers: mediaResponseHeaders,
  })
  fencePublication(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(options(mediaBatchFencePublicationSchema)) body: unknown,
  ) {
    return this.media.fencePublication(bearerToken(auth), id, body);
  }
  @Post('batches/:id/layout')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'layoutMediaPublicationBatchV3' })
  @ApiOkResponse({
    standardSchema: mediaBatchStatusSchema,
    headers: mediaResponseHeaders,
  })
  layout(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(options(mediaBatchLayoutSchema)) body: unknown,
  ) {
    return this.media.layout(bearerToken(auth), id, body);
  }
  @Post('batches/:id/seal')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'sealMediaPublicationBatchV3' })
  @ApiOkResponse({
    standardSchema: mediaBatchStatusSchema,
    headers: mediaResponseHeaders,
  })
  seal(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(options(mediaBatchSealSchema)) body: unknown,
  ) {
    return this.media.seal(bearerToken(auth), id, body);
  }
  @Post('batches/:id/reopen')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'reopenMediaPublicationBatchV3' })
  @ApiOkResponse({
    standardSchema: mediaBatchStatusSchema,
    headers: mediaResponseHeaders,
  })
  reopen(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(options(mediaBatchReopenSchema)) body: unknown,
  ) {
    return this.media.reopen(bearerToken(auth), id, body);
  }
  @Post('batches/:id/members/prepare')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'prepareMediaBatchMemberV3' })
  @ApiOkResponse({
    standardSchema: mediaMemberStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepareMember(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(options(mediaMemberPrepareSchema)) body: unknown,
  ) {
    return this.media.prepareMember(bearerToken(auth), id, body);
  }
  @Get('upload-intents/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readMediaBatchMemberV3' })
  @ApiOkResponse({
    standardSchema: mediaMemberStatusSchema,
    headers: mediaResponseHeaders,
  })
  memberStatus(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return this.media.memberStatus(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/grant')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'grantMediaBatchMemberV3' })
  @ApiOkResponse({
    standardSchema: mediaGrantSchema,
    headers: mediaResponseHeaders,
  })
  grant(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.grant(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/finalize')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'finalizeMediaBatchMemberV3' })
  @ApiOkResponse({
    standardSchema: mediaMemberStatusSchema,
    headers: mediaResponseHeaders,
  })
  finalize(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.finalizeMember(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'cancelMediaBatchMemberV3' })
  @ApiOkResponse({
    standardSchema: mediaMemberStatusSchema,
    headers: mediaResponseHeaders,
  })
  cancelMember(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.cancelMember(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/uploads/:grantId')
  @HttpCode(200)
  @MediaPrivateResponse()
  @UseInterceptors(MediaMultipartInterceptorV3)
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
    operationId: 'uploadMediaBatchMemberMultipartV3',
    description:
      'Exactly the shared single-file multipart parser, no text fields or query.',
  })
  @ApiOkResponse({
    standardSchema: mediaUploadObservedSchema,
    headers: mediaResponseHeaders,
  })
  upload(
    @Req() request: Request,
    @Param('id', idOptions) _id: string,
    @Param('grantId', idOptions) _grantId: string,
    @Query(emptyOptions) _query: unknown,
  ) {
    return observedMultipart(request);
  }
}
