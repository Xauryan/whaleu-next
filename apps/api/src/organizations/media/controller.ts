import { OrganizationMediaRequestGuard } from './request-guard.js';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import {
  organizationMediaStatusSchema,
  organizationMediaRecoverySchema,
  organizationMediaGrantSchema,
  organizationMediaUploadObservedSchema,
  organizationDescriptorSchema,
} from '../../media/contracts-organization.js';
import {
  mediaResponseHeaders,
  mediaBinaryResponseHeaders,
} from '../../media/openapi.js';
const organizationEmptyBodySchema = z.preprocess(
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
  organizationMediaSlotSchema,
  prepareOrganizationMediaSchema,
  cancelOrganizationMediaRequestSchema,
} from '../../media/contracts-organization.js';
import type { OrganizationMediaSlot } from '../../media/contracts-organization.js';
import {
  OrganizationMediaService,
  ORGANIZATION_MEDIA_RUNTIME,
} from './facade.js';
import type { OrganizationMediaRuntime } from './facade.js';
const empty = z.strictObject({});
const emptyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(empty)],
};
const emptyBodyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(organizationEmptyBodySchema)],
};
const idOptions = {
  schema: mediaV2IdSchema,
  pipes: [new SchemaValidationPipe(mediaV2IdSchema)],
};
const keyOptions = {
  schema: organizationMediaSlotSchema,
  pipes: [new SchemaValidationPipe(organizationMediaSlotSchema)],
};
const revision = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());
const readQuery = z.strictObject({ applicationRevision: revision });
const audienceSchema = z.enum(['public', 'management']);
@Injectable()
export class OrganizationMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(OrganizationMediaService) media: OrganizationMediaService,
    @Inject(ORGANIZATION_MEDIA_RUNTIME)
    runtime: OrganizationMediaRuntime | null,
  ) {
    super(media, runtime?.ingressStorage ?? null);
  }
}
@ApiTags('Organization media')
@MediaErrorResponses()
@UseGuards(OrganizationMediaRequestGuard)
@Controller('v3/media/organizations')
export class OrganizationMediaController {
  constructor(
    @Inject(OrganizationMediaService)
    private readonly media: OrganizationMediaService,
  ) {}
  @Post('upload-intents')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'prepareOrganizationMedia' })
  @ApiOkResponse({
    standardSchema: organizationMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: prepareOrganizationMediaSchema,
      pipes: [new SchemaValidationPipe(prepareOrganizationMediaSchema)],
    })
    input: unknown,
  ) {
    return this.media.prepare(bearerToken(auth), input);
  }
  @Get('upload-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverOrganizationMedia' })
  @ApiOkResponse({
    standardSchema: organizationMediaRecoverySchema,
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
  @ApiOperation({ operationId: 'cancelOrganizationMediaRequest' })
  @ApiOkResponse({
    standardSchema: organizationMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancelRequest(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: cancelOrganizationMediaRequestSchema,
      pipes: [new SchemaValidationPipe(cancelOrganizationMediaRequestSchema)],
    })
    input: unknown,
  ) {
    return this.media.cancelRequest(bearerToken(auth), id, input);
  }
  @Get('upload-intents/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readOrganizationMediaStatus' })
  @ApiOkResponse({
    standardSchema: organizationMediaStatusSchema,
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
  @ApiOperation({ operationId: 'grantOrganizationMedia' })
  @ApiOkResponse({
    standardSchema: organizationMediaGrantSchema,
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
  @UseInterceptors(OrganizationMultipartInterceptor)
  @ApiOperation({ operationId: 'uploadOrganizationMedia' })
  @ApiOkResponse({
    standardSchema: organizationMediaUploadObservedSchema,
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
  @ApiOperation({ operationId: 'finalizeOrganizationMedia' })
  @ApiOkResponse({
    standardSchema: organizationMediaStatusSchema,
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
  @ApiOperation({ operationId: 'cancelOrganizationMedia' })
  @ApiOkResponse({
    standardSchema: organizationMediaStatusSchema,
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
  @Get(':audience/organizations/:organizationId/slots/:slot/descriptor')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readOrganizationMediaDescriptor' })
  @ApiOkResponse({
    standardSchema: organizationDescriptorSchema,
    headers: mediaResponseHeaders,
  })
  descriptor(
    @Headers('authorization') auth: unknown,
    @Param('audience', {
      schema: audienceSchema,
      pipes: [new SchemaValidationPipe(audienceSchema)],
    })
    audience: 'public' | 'management',
    @Param('organizationId', idOptions) organizationId: string,
    @Param('slot', keyOptions) slot: OrganizationMediaSlot,
    @Query({ schema: readQuery, pipes: [new SchemaValidationPipe(readQuery)] })
    query: z.infer<typeof readQuery>,
    @Body(emptyBodyOptions) _body: unknown,
  ) {
    return this.media.descriptor(bearerToken(auth), {
      organizationId,
      slot,
      applicationRevision: query.applicationRevision,
      audience,
      campusId: null,
    });
  }
  @Get(
    ':audience/organizations/:organizationId/slots/:slot/bindings/:bindingId/:variant',
  )
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readOrganizationMediaVariant',
    description:
      'Exact current organization/revision/slot and image Safety proof; authenticated, no redirect or public cache. Public manager contact is forbidden.',
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
    @Param('organizationId', idOptions) organizationId: string,
    @Param('slot', keyOptions) slot: OrganizationMediaSlot,
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
        organizationId,
        slot,
        applicationRevision: query.applicationRevision,
        audience,
        campusId: null,
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
