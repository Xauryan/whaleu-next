import { ActivityMediaRequestGuard } from './request-guard.js';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import {
  activityMediaStatusSchema,
  activityMediaRecoverySchema,
  activityMediaGrantSchema,
  activityMediaUploadObservedSchema,
  activityDescriptorSchema,
} from '../../media/contracts-activity.js';
import {
  mediaResponseHeaders,
  mediaBinaryResponseHeaders,
} from '../../media/openapi.js';
const activityEmptyBodySchema = z.preprocess(
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
  activityMediaSlotSchema,
  prepareActivityMediaSchema,
  cancelActivityMediaRequestSchema,
} from '../../media/contracts-activity.js';
import type { ActivityMediaSlot } from '../../media/contracts-activity.js';
import { ActivityMediaService, ACTIVITY_MEDIA_RUNTIME } from './facade.js';
import type { ActivityMediaRuntime } from './facade.js';
const empty = z.strictObject({});
const emptyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(empty)],
};
const emptyBodyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(activityEmptyBodySchema)],
};
const idOptions = {
  schema: mediaV2IdSchema,
  pipes: [new SchemaValidationPipe(mediaV2IdSchema)],
};
const keyOptions = {
  schema: activityMediaSlotSchema,
  pipes: [new SchemaValidationPipe(activityMediaSlotSchema)],
};
const revision = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());
const readQuery = z.strictObject({ revision: revision });
const audienceSchema = z.enum(['public', 'management']);
@Injectable()
export class ActivityMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(ActivityMediaService) media: ActivityMediaService,
    @Inject(ACTIVITY_MEDIA_RUNTIME)
    runtime: ActivityMediaRuntime | null,
  ) {
    super(media, runtime?.ingressStorage ?? null);
  }
}
@ApiTags('Activity media')
@MediaErrorResponses()
@UseGuards(ActivityMediaRequestGuard)
@Controller('v3/media/activities')
export class ActivityMediaController {
  constructor(
    @Inject(ActivityMediaService)
    private readonly media: ActivityMediaService,
  ) {}
  @Post('upload-intents')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'prepareActivityMedia' })
  @ApiOkResponse({
    standardSchema: activityMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: prepareActivityMediaSchema,
      pipes: [new SchemaValidationPipe(prepareActivityMediaSchema)],
    })
    input: unknown,
  ) {
    return this.media.prepare(bearerToken(auth), input);
  }
  @Get('upload-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverActivityMedia' })
  @ApiOkResponse({
    standardSchema: activityMediaRecoverySchema,
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
  @ApiOperation({ operationId: 'cancelActivityMediaRequest' })
  @ApiOkResponse({
    standardSchema: activityMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelRequest(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: cancelActivityMediaRequestSchema,
      pipes: [new SchemaValidationPipe(cancelActivityMediaRequestSchema)],
    })
    input: unknown,
  ) {
    return this.media.cancelRequest(bearerToken(auth), id, input);
  }
  @Get('upload-intents/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readActivityMediaStatus' })
  @ApiOkResponse({
    standardSchema: activityMediaStatusSchema,
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
  @ApiOperation({ operationId: 'grantActivityMedia' })
  @ApiOkResponse({
    standardSchema: activityMediaGrantSchema,
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
  @UseInterceptors(ActivityMultipartInterceptor)
  @ApiOperation({ operationId: 'uploadActivityMedia' })
  @ApiOkResponse({
    standardSchema: activityMediaUploadObservedSchema,
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
  @ApiOperation({ operationId: 'finalizeActivityMedia' })
  @ApiOkResponse({
    standardSchema: activityMediaStatusSchema,
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
  @ApiOperation({ operationId: 'cancelActivityMedia' })
  @ApiOkResponse({
    standardSchema: activityMediaStatusSchema,
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
  @Get(':audience/activities/:activityId/slots/:slot/descriptor')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readActivityMediaDescriptor' })
  @ApiOkResponse({
    standardSchema: activityDescriptorSchema,
    headers: mediaResponseHeaders,
  })
  descriptor(
    @Headers('authorization') auth: unknown,
    @Param('audience', {
      schema: audienceSchema,
      pipes: [new SchemaValidationPipe(audienceSchema)],
    })
    audience: 'public' | 'management',
    @Param('activityId', idOptions) activityId: string,
    @Param('slot', keyOptions) slot: ActivityMediaSlot,
    @Query({ schema: readQuery, pipes: [new SchemaValidationPipe(readQuery)] })
    query: z.infer<typeof readQuery>,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.descriptor(bearerToken(auth), {
      activityId,
      slot,
      revision: query.revision,
      audience,
    });
  }
  @Get(
    ':audience/activities/:activityId/slots/:slot/bindings/:bindingId/:variant',
  )
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readActivityMediaVariant',
    description:
      'Exact current activity/revision/slot and image Safety proof; authenticated, no redirect or public cache. Only the exact current activity image is served.',
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
    @Param('activityId', idOptions) activityId: string,
    @Param('slot', keyOptions) slot: ActivityMediaSlot,
    @Param('bindingId', idOptions) bindingId: string,
    @Param('variant', {
      schema: mediaVariantSchema,
      pipes: [new SchemaValidationPipe(mediaVariantSchema)],
    })
    variant: MediaVariantName,
    @Query({ schema: readQuery, pipes: [new SchemaValidationPipe(readQuery)] })
    query: z.infer<typeof readQuery>,
    @Body(emptyBodyOptions) _body: unknown,
    @Res() response: Response,
  ) {
    const result = await this.media.open(
      bearerToken(auth),
      {
        activityId,
        slot,
        revision: query.revision,
        audience,
      },
      bindingId,
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
