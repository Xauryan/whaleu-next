import { ErrandMediaRequestGuard } from './request-guard.js';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import {
  errandMediaStatusSchema,
  errandMediaRecoverySchema,
  errandMediaGrantSchema,
  errandMediaUploadObservedSchema,
  errandDescriptorSchema,
} from '../../media/contracts-errand.js';
import {
  mediaResponseHeaders,
  mediaBinaryResponseHeaders,
} from '../../media/openapi.js';
const errandEmptyBodySchema = z.preprocess(
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
  errandMediaSlotSchema,
  prepareErrandMediaSchema,
  cancelErrandMediaRequestSchema,
} from '../../media/contracts-errand.js';
import type { ErrandMediaSlot } from '../../media/contracts-errand.js';
import { ErrandMediaService, ERRAND_MEDIA_RUNTIME } from './facade.js';
import type { ErrandMediaRuntime } from './facade.js';
const empty = z.strictObject({});
const emptyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(empty)],
};
const emptyBodyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(errandEmptyBodySchema)],
};
const idOptions = {
  schema: mediaV2IdSchema,
  pipes: [new SchemaValidationPipe(mediaV2IdSchema)],
};
const keyOptions = {
  schema: errandMediaSlotSchema,
  pipes: [new SchemaValidationPipe(errandMediaSlotSchema)],
};
const revision = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());
const readQuery = z.strictObject({
  revision,
});
const credential = bearerToken;
@Injectable()
export class ErrandMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(ErrandMediaService) media: ErrandMediaService,
    @Inject(ERRAND_MEDIA_RUNTIME)
    runtime: ErrandMediaRuntime | null,
  ) {
    super(media, runtime?.ingressStorage ?? null);
  }
}
@ApiTags('Errand media')
@ApiBearerAuth('accessToken')
@MediaErrorResponses()
@UseGuards(ErrandMediaRequestGuard)
@Controller('v3/media/errands')
export class ErrandMediaController {
  constructor(
    @Inject(ErrandMediaService)
    private readonly media: ErrandMediaService,
  ) {}
  @Post('upload-intents')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'prepareErrandMedia' })
  @ApiOkResponse({
    standardSchema: errandMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: prepareErrandMediaSchema,
      pipes: [new SchemaValidationPipe(prepareErrandMediaSchema)],
    })
    input: unknown,
  ) {
    return this.media.prepare(bearerToken(auth), input);
  }
  @Get('upload-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverErrandMedia' })
  @ApiOkResponse({
    standardSchema: errandMediaRecoverySchema,
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
  @ApiOperation({ operationId: 'cancelErrandMediaRequest' })
  @ApiOkResponse({
    standardSchema: errandMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelRequest(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: cancelErrandMediaRequestSchema,
      pipes: [new SchemaValidationPipe(cancelErrandMediaRequestSchema)],
    })
    input: unknown,
  ) {
    return this.media.cancelRequest(bearerToken(auth), id, input);
  }
  @Get('upload-intents/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readErrandMediaStatus' })
  @ApiOkResponse({
    standardSchema: errandMediaStatusSchema,
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
  @ApiOperation({ operationId: 'grantErrandMedia' })
  @ApiOkResponse({
    standardSchema: errandMediaGrantSchema,
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
  @UseInterceptors(ErrandMultipartInterceptor)
  @ApiOperation({ operationId: 'uploadErrandMedia' })
  @ApiOkResponse({
    standardSchema: errandMediaUploadObservedSchema,
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
  @ApiOperation({ operationId: 'finalizeErrandMedia' })
  @ApiOkResponse({
    standardSchema: errandMediaStatusSchema,
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
  @ApiOperation({ operationId: 'cancelErrandMedia' })
  @ApiOkResponse({
    standardSchema: errandMediaStatusSchema,
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
  @Get('orders/:orderId/:slot')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readErrandMediaDescriptor' })
  @ApiOkResponse({
    standardSchema: errandDescriptorSchema,
    headers: mediaResponseHeaders,
  })
  descriptor(
    @Headers('authorization') auth: unknown,
    @Param('orderId', idOptions) orderId: string,
    @Param('slot', keyOptions) slot: ErrandMediaSlot,
    @Query({ schema: readQuery, pipes: [new SchemaValidationPipe(readQuery)] })
    query: z.infer<typeof readQuery>,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.descriptor(credential(auth), {
      orderId,
      slot,
      mediaRevision: query.revision,
    });
  }
  @Get('orders/:orderId/:slot/bindings/:bindingId/:variant')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readErrandMediaVariant',
    description:
      'Exact current errand/revision/slot and image Safety proof; authenticated business reads, no redirect or public cache. Only the exact current errand image is served.',
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
    @Param('orderId', idOptions) orderId: string,
    @Param('slot', keyOptions) slot: ErrandMediaSlot,
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
        orderId,
        slot,
        mediaRevision: query.revision,
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
