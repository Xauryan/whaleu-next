import { AnnouncementMediaRequestGuard } from './request-guard.js';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import {
  announcementMediaStatusSchema,
  announcementMediaRecoverySchema,
  announcementMediaGrantSchema,
  announcementMediaUploadObservedSchema,
  announcementDescriptorSchema,
} from '../../media/contracts-announcement.js';
import {
  mediaResponseHeaders,
  mediaBinaryResponseHeaders,
} from '../../media/openapi.js';
const announcementEmptyBodySchema = z.preprocess(
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
  announcementMediaSlotSchema,
  prepareAnnouncementMediaSchema,
  cancelAnnouncementMediaRequestSchema,
} from '../../media/contracts-announcement.js';
import type { AnnouncementMediaSlot } from '../../media/contracts-announcement.js';
import {
  AnnouncementMediaService,
  ANNOUNCEMENT_MEDIA_RUNTIME,
} from './facade.js';
import type { AnnouncementMediaRuntime } from './facade.js';
const empty = z.strictObject({});
const emptyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(empty)],
};
const emptyBodyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(announcementEmptyBodySchema)],
};
const idOptions = {
  schema: mediaV2IdSchema,
  pipes: [new SchemaValidationPipe(mediaV2IdSchema)],
};
const keyOptions = {
  schema: announcementMediaSlotSchema,
  pipes: [new SchemaValidationPipe(announcementMediaSlotSchema)],
};
const revision = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());
const readQuery = z.strictObject({
  revision,
  campusId: mediaV2IdSchema.optional(),
});
const credential = (auth: unknown) =>
  auth === undefined ? null : bearerToken(auth);
const audienceSchema = z.enum(['public', 'management']);
@Injectable()
export class AnnouncementMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(AnnouncementMediaService) media: AnnouncementMediaService,
    @Inject(ANNOUNCEMENT_MEDIA_RUNTIME)
    runtime: AnnouncementMediaRuntime | null,
  ) {
    super(media, runtime?.ingressStorage ?? null);
  }
}
@ApiTags('Announcement media')
@MediaErrorResponses()
@UseGuards(AnnouncementMediaRequestGuard)
@Controller('v3/media/announcements')
export class AnnouncementMediaController {
  constructor(
    @Inject(AnnouncementMediaService)
    private readonly media: AnnouncementMediaService,
  ) {}
  @Post('upload-intents')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'prepareAnnouncementMedia' })
  @ApiOkResponse({
    standardSchema: announcementMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: prepareAnnouncementMediaSchema,
      pipes: [new SchemaValidationPipe(prepareAnnouncementMediaSchema)],
    })
    input: unknown,
  ) {
    return this.media.prepare(bearerToken(auth), input);
  }
  @Get('upload-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverAnnouncementMedia' })
  @ApiOkResponse({
    standardSchema: announcementMediaRecoverySchema,
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
  @ApiOperation({ operationId: 'cancelAnnouncementMediaRequest' })
  @ApiOkResponse({
    standardSchema: announcementMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelRequest(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: cancelAnnouncementMediaRequestSchema,
      pipes: [new SchemaValidationPipe(cancelAnnouncementMediaRequestSchema)],
    })
    input: unknown,
  ) {
    return this.media.cancelRequest(bearerToken(auth), id, input);
  }
  @Get('upload-intents/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readAnnouncementMediaStatus' })
  @ApiOkResponse({
    standardSchema: announcementMediaStatusSchema,
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
  @ApiOperation({ operationId: 'grantAnnouncementMedia' })
  @ApiOkResponse({
    standardSchema: announcementMediaGrantSchema,
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
  @UseInterceptors(AnnouncementMultipartInterceptor)
  @ApiOperation({ operationId: 'uploadAnnouncementMedia' })
  @ApiOkResponse({
    standardSchema: announcementMediaUploadObservedSchema,
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
  @ApiOperation({ operationId: 'finalizeAnnouncementMedia' })
  @ApiOkResponse({
    standardSchema: announcementMediaStatusSchema,
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
  @ApiOperation({ operationId: 'cancelAnnouncementMedia' })
  @ApiOkResponse({
    standardSchema: announcementMediaStatusSchema,
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
  @Get(':audience/announcements/:announcementId/slots/:slot/descriptor')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readAnnouncementMediaDescriptor' })
  @ApiOkResponse({
    standardSchema: announcementDescriptorSchema,
    headers: mediaResponseHeaders,
  })
  descriptor(
    @Headers('authorization') auth: unknown,
    @Param('audience', {
      schema: audienceSchema,
      pipes: [new SchemaValidationPipe(audienceSchema)],
    })
    audience: 'public' | 'management',
    @Param('announcementId', idOptions) announcementId: string,
    @Param('slot', keyOptions) slot: AnnouncementMediaSlot,
    @Query({ schema: readQuery, pipes: [new SchemaValidationPipe(readQuery)] })
    query: z.infer<typeof readQuery>,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.descriptor(credential(auth), {
      announcementId,
      slot,
      revision: query.revision,
      audience,
      campusId: query.campusId ?? null,
    });
  }
  @Get(
    ':audience/announcements/:announcementId/slots/:slot/bindings/:bindingId/:variant',
  )
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readAnnouncementMediaVariant',
    description:
      'Exact current announcement/revision/slot and image Safety proof; optional guest public reads, no redirect or public cache. Only the exact current announcement image is served.',
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
    @Param('audience', {
      schema: audienceSchema,
      pipes: [new SchemaValidationPipe(audienceSchema)],
    })
    audience: 'public' | 'management',
    @Param('announcementId', idOptions) announcementId: string,
    @Param('slot', keyOptions) slot: AnnouncementMediaSlot,
    @Param('bindingId', idOptions) bindingId: string,
    @Param('variant', {
      schema: mediaVariantSchema,
      pipes: [new SchemaValidationPipe(mediaVariantSchema)],
    })
    variant: MediaVariantName,
    @Query({ schema: readQuery, pipes: [new SchemaValidationPipe(readQuery)] })
    query: z.infer<typeof readQuery>,
    @Body(emptyBodyOptions) _body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const result = await this.media.open(
      credential(auth),
      {
        announcementId,
        slot,
        revision: query.revision,
        audience,
        campusId: query.campusId ?? null,
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
