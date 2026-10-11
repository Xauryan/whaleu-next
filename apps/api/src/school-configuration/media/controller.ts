import { SchoolQrRequestGuard } from './request-guard.js';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import {
  schoolQrMediaStatusSchema,
  schoolQrMediaRecoverySchema,
  schoolQrMediaGrantSchema,
  schoolQrMediaUploadObservedSchema,
  schoolQrDescriptorSchema,
} from '../../media/contracts-school-qr.js';
import {
  mediaResponseHeaders,
  mediaBinaryResponseHeaders,
} from '../../media/openapi.js';
import { schoolEmptyBodySchema } from '../contracts.js';
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
import { randomUUID } from 'node:crypto';
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
  schoolQrEntryKeySchema,
  prepareSchoolQrMediaSchema,
  cancelSchoolQrMediaRequestSchema,
} from '../../media/contracts-school-qr.js';
import type { SchoolQrEntryKey } from '../../media/contracts-school-qr.js';
import { SchoolQrMediaService, SCHOOL_QR_MEDIA_RUNTIME } from './facade.js';
import type { SchoolQrMediaRuntime } from './facade.js';
const empty = z.strictObject({});
const emptyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(empty)],
};
const emptyBodyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(schoolEmptyBodySchema)],
};
const idOptions = {
  schema: mediaV2IdSchema,
  pipes: [new SchemaValidationPipe(mediaV2IdSchema)],
};
const keyOptions = {
  schema: schoolQrEntryKeySchema,
  pipes: [new SchemaValidationPipe(schoolQrEntryKeySchema)],
};
const revision = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());
const publicQuery = z.strictObject({
  campusId: mediaV2IdSchema,
  entryRevision: revision,
});
const managementQuery = z.strictObject({ entryRevision: revision });
function credential(auth: unknown): string | null {
  return auth === undefined ? null : bearerToken(auth);
}
const connections = new WeakMap<object, string>();
function connectionKey(request: Request): string {
  let key = connections.get(request.socket);
  if (!key) {
    key = randomUUID();
    connections.set(request.socket, key);
  }
  return key;
}
@Injectable()
export class SchoolQrMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(SchoolQrMediaService) media: SchoolQrMediaService,
    @Inject(SCHOOL_QR_MEDIA_RUNTIME) runtime: SchoolQrMediaRuntime | null,
  ) {
    super(media, runtime?.ingressStorage ?? null);
  }
}
@ApiTags('School configuration QR media')
@MediaErrorResponses()
@UseGuards(SchoolQrRequestGuard)
@Controller('v3/media/school-configuration')
export class SchoolQrMediaController {
  constructor(
    @Inject(SchoolQrMediaService) private readonly media: SchoolQrMediaService,
  ) {}
  @Post('upload-intents')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'prepareSchoolQrMedia' })
  @ApiOkResponse({
    standardSchema: schoolQrMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: prepareSchoolQrMediaSchema,
      pipes: [new SchemaValidationPipe(prepareSchoolQrMediaSchema)],
    })
    input: unknown,
  ) {
    return this.media.prepare(bearerToken(auth), input);
  }
  @Get('upload-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverSchoolQrMedia' })
  @ApiOkResponse({
    standardSchema: schoolQrMediaRecoverySchema,
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
  @ApiOperation({ operationId: 'cancelSchoolQrMediaRequest' })
  @ApiOkResponse({
    standardSchema: schoolQrMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelRequest(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: cancelSchoolQrMediaRequestSchema,
      pipes: [new SchemaValidationPipe(cancelSchoolQrMediaRequestSchema)],
    })
    input: unknown,
  ) {
    return this.media.cancelRequest(bearerToken(auth), id, input);
  }
  @Get('upload-intents/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readSchoolQrMediaStatus' })
  @ApiOkResponse({
    standardSchema: schoolQrMediaStatusSchema,
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
  @ApiOperation({ operationId: 'grantSchoolQrMedia' })
  @ApiOkResponse({
    standardSchema: schoolQrMediaGrantSchema,
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
  @UseInterceptors(SchoolQrMultipartInterceptor)
  @ApiOperation({ operationId: 'uploadSchoolQrMedia' })
  @ApiOkResponse({
    standardSchema: schoolQrMediaUploadObservedSchema,
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
  @ApiOperation({ operationId: 'finalizeSchoolQrMedia' })
  @ApiOkResponse({
    standardSchema: schoolQrMediaStatusSchema,
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
  @ApiOperation({ operationId: 'cancelSchoolQrMedia' })
  @ApiOkResponse({
    standardSchema: schoolQrMediaStatusSchema,
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
  @Get('entries/:key/descriptor')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readSchoolQrDescriptor' })
  @ApiOkResponse({
    standardSchema: schoolQrDescriptorSchema,
    headers: mediaResponseHeaders,
  })
  descriptor(
    @Headers('authorization') auth: unknown,
    @Param('key', keyOptions) key: SchoolQrEntryKey,
    @Query({
      schema: publicQuery,
      pipes: [new SchemaValidationPipe(publicQuery)],
    })
    query: z.infer<typeof publicQuery>,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.descriptor(
      credential(auth),
      { campusId: query.campusId },
      key,
      query.entryRevision,
    );
  }
  @Get('errands/:orderId/descriptor')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readErrandTargetQrDescriptor',
    description:
      'Exact enabled errand group revision at a currently readable order target. Authenticated order read grants no school management authority.',
  })
  @ApiOkResponse({
    standardSchema: schoolQrDescriptorSchema,
    headers: mediaResponseHeaders,
  })
  errandDescriptor(
    @Headers('authorization') auth: unknown,
    @Param('orderId', idOptions) orderId: string,
    @Query({
      schema: managementQuery,
      pipes: [new SchemaValidationPipe(managementQuery)],
    })
    query: z.infer<typeof managementQuery>,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.descriptor(
      bearerToken(auth),
      { orderId },
      'errand',
      query.entryRevision,
    );
  }
  @Get('errands/:orderId/bindings/:bindingId/:variant')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readErrandTargetQrVariant',
    description:
      'Revalidates readable order, immutable target, exact enabled entry revision, binding and Safety before and after object open.',
  })
  @ApiOkResponse({
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
    },
    headers: mediaBinaryResponseHeaders,
  })
  async errandOpen(
    @Headers('authorization') auth: unknown,
    @Headers('range') range: string | undefined,
    @Param('orderId', idOptions) orderId: string,
    @Param('bindingId', idOptions) bindingId: string,
    @Param('variant', {
      schema: mediaVariantSchema,
      pipes: [new SchemaValidationPipe(mediaVariantSchema)],
    })
    variant: MediaVariantName,
    @Query({
      schema: managementQuery,
      pipes: [new SchemaValidationPipe(managementQuery)],
    })
    query: z.infer<typeof managementQuery>,
    @Body(emptyBodyOptions) _body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.stream(
      bearerToken(auth),
      { orderId },
      'errand',
      query.entryRevision,
      bindingId,
      variant,
      range,
      request,
      response,
    );
  }
  @Get('management/regions/:regionId/entries/:key/descriptor')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readManagedSchoolQrDescriptor' })
  @ApiOkResponse({
    standardSchema: schoolQrDescriptorSchema,
    headers: mediaResponseHeaders,
  })
  managementDescriptor(
    @Headers('authorization') auth: unknown,
    @Param('regionId', idOptions) regionId: string,
    @Param('key', keyOptions) key: SchoolQrEntryKey,
    @Query({
      schema: managementQuery,
      pipes: [new SchemaValidationPipe(managementQuery)],
    })
    query: z.infer<typeof managementQuery>,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.descriptor(
      bearerToken(auth),
      { regionId },
      key,
      query.entryRevision,
    );
  }
  @Get('entries/:key/bindings/:bindingId/:variant')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readSchoolQrVariant',
    description:
      'Exact current school configuration revision and enabled slot, two checks around storage, no redirect or public cache. Public review QR is prohibited.',
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
    @Param('key', keyOptions) key: SchoolQrEntryKey,
    @Param('bindingId', idOptions) bindingId: string,
    @Param('variant', {
      schema: mediaVariantSchema,
      pipes: [new SchemaValidationPipe(mediaVariantSchema)],
    })
    variant: MediaVariantName,
    @Query({
      schema: publicQuery,
      pipes: [new SchemaValidationPipe(publicQuery)],
    })
    query: z.infer<typeof publicQuery>,
    @Body(emptyBodyOptions) _body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.stream(
      credential(auth),
      { campusId: query.campusId },
      key,
      query.entryRevision,
      bindingId,
      variant,
      range,
      request,
      response,
    );
  }
  @Get('management/regions/:regionId/entries/:key/bindings/:bindingId/:variant')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readManagedSchoolQrVariant',
    description:
      'Exact current school configuration revision and enabled slot, two checks around storage, no redirect or public cache. Public review QR is prohibited.',
  })
  @ApiOkResponse({
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
    },
    headers: mediaBinaryResponseHeaders,
  })
  async managementOpen(
    @Headers('authorization') auth: unknown,
    @Headers('range') range: string | undefined,
    @Param('regionId', idOptions) regionId: string,
    @Param('key', keyOptions) key: SchoolQrEntryKey,
    @Param('bindingId', idOptions) bindingId: string,
    @Param('variant', {
      schema: mediaVariantSchema,
      pipes: [new SchemaValidationPipe(mediaVariantSchema)],
    })
    variant: MediaVariantName,
    @Query({
      schema: managementQuery,
      pipes: [new SchemaValidationPipe(managementQuery)],
    })
    query: z.infer<typeof managementQuery>,
    @Body(emptyBodyOptions) _body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.stream(
      bearerToken(auth),
      { regionId },
      key,
      query.entryRevision,
      bindingId,
      variant,
      range,
      request,
      response,
    );
  }
  private async stream(
    token: string | null,
    target: { campusId: string } | { regionId: string } | { orderId: string },
    key: SchoolQrEntryKey,
    revision: number,
    bindingId: string,
    variant: MediaVariantName,
    range: string | undefined,
    request: Request,
    response: Response,
  ) {
    const result = await this.media.open(
      token,
      target,
      key,
      revision,
      bindingId,
      variant,
      connectionKey(request),
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
