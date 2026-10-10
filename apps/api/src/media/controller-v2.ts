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
import { MEDIA_UPLOAD_APPLICATION_V2 } from './application-v2.js';
import type { MediaUploadApplicationV2 } from './application-v2.js';
import {
  mediaCancelRequestSchema,
  mediaCancelV2Schema,
  mediaGrantSchema,
  mediaRequestRecoverySchema,
  mediaStatusV2Schema,
  mediaUploadObservedSchema,
  prepareMediaV2Schema,
  mediaV2IdSchema,
} from './contracts-v2.js';
import {
  MediaMultipartInterceptor,
  observedMultipart,
} from './multipart-ingress.js';
import {
  MediaErrorResponses,
  MediaPrivateResponse,
  mediaResponseHeaders,
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
@ApiTags('Authenticated media')
@ApiBearerAuth('accessToken')
@MediaErrorResponses()
@Controller('v2/media')
export class MediaUploadControllerV2 {
  constructor(
    @Inject(MEDIA_UPLOAD_APPLICATION_V2)
    private readonly media: MediaUploadApplicationV2,
  ) {}
  @Post('upload-intents')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'prepareMediaUploadIntentV2',
    description:
      'Immutable single-image intent with exact original-byte digest. Default runtime unavailable.',
  })
  @ApiOkResponse({
    standardSchema: mediaStatusV2Schema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Body({
      schema: prepareMediaV2Schema,
      pipes: [new SchemaValidationPipe(prepareMediaV2Schema)],
    })
    body: unknown,
  ) {
    return this.media.prepareV2(bearerToken(auth), body);
  }
  @Get('upload-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'recoverMediaUploadRequestV2',
    description:
      'Original authenticated actor receipt-only recovery. Does not grant content read authority.',
  })
  @ApiOkResponse({
    standardSchema: mediaRequestRecoverySchema,
    headers: mediaResponseHeaders,
  })
  recover(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
  ) {
    return this.media.recoverRequest(bearerToken(auth), id);
  }
  @Post('upload-requests/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'cancelMediaUploadRequestV2',
    description:
      'Original actor cancellation fence prevents a late prepare, including when no intent is recorded yet.',
  })
  @ApiOkResponse({
    standardSchema: mediaRequestRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelRequest(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
    @Body({
      schema: mediaCancelRequestSchema,
      pipes: [new SchemaValidationPipe(mediaCancelRequestSchema)],
    })
    body: unknown,
  ) {
    return this.media.cancelRequest(bearerToken(auth), id, body);
  }
  @Get('upload-intents/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readMediaUploadIntentV2' })
  @ApiOkResponse({
    standardSchema: mediaStatusV2Schema,
    headers: mediaResponseHeaders,
  })
  status(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
  ) {
    return this.media.statusV2(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/grant')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'grantMediaUploadV2',
    description:
      'Current-session, generation and deadline bound first-party multipart grant. No URL or bearer capability.',
  })
  @ApiOkResponse({
    standardSchema: mediaGrantSchema,
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
  @Post('upload-intents/:id/uploads/:grantId')
  @HttpCode(200)
  @MediaPrivateResponse()
  @UseInterceptors(MediaMultipartInterceptor)
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
    operationId: 'uploadMediaMultipartV2',
    description:
      'Exactly one file part named file, no fields/query. Admission precedes native Multer parsing. Complete multipart and full wire budget are required before observation.',
  })
  @ApiOkResponse({
    standardSchema: mediaUploadObservedSchema,
    headers: mediaResponseHeaders,
  })
  upload(
    @Req() request: Request,
    @Param('id', idOptions) _id: string,
    @Param('grantId', idOptions) _grantId: string,
    @Query(emptyOptions) _query: Record<string, never>,
  ) {
    return observedMultipart(request);
  }
  @Post('upload-intents/:id/finalize')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'finalizeMediaUploadIntentV2' })
  @ApiOkResponse({
    standardSchema: mediaStatusV2Schema,
    headers: mediaResponseHeaders,
  })
  finalize(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.finalizeV2(bearerToken(auth), id);
  }
  @Post('upload-intents/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'cancelMediaUploadIntentV2',
    description:
      'Returns logical terminal or historical binding independently of physical cleanup. Detached bindings also belong to owner deletion.',
  })
  @ApiOkResponse({
    standardSchema: mediaCancelV2Schema,
    headers: mediaResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: string | undefined,
    @Query(emptyOptions) _query: Record<string, never>,
    @Param('id', idOptions) id: string,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.media.cancelV2(bearerToken(auth), id);
  }
}
