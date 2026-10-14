import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { mediaVariantSchema } from '../../media/contracts.js';
import type { MediaVariantName } from '../../media/contracts.js';
import {
  campusToolMediaDescriptorSchema,
  campusToolMediaTargetSchema,
} from '../../media/contracts-campus-tools.js';
import { CampusToolsRequestGuard } from '../request-guard.js';
import { toolId } from '../contracts.js';
import { emptyToolQuery, emptyToolBody } from '../public-contracts.js';
import { CampusToolsMediaService } from './service.js';
const idOptions = { schema: toolId, pipes: [new SchemaValidationPipe(toolId)] };
const credential = (auth: unknown) =>
  auth === undefined ? null : bearerToken(auth);
const connections = new WeakMap<object, string>();
function connectionKey(request: Request) {
  let key = connections.get(request.socket);
  if (!key) {
    key = randomUUID();
    connections.set(request.socket, key);
  }
  return key;
}
@ApiTags('Campus tools Media')
@UseGuards(CampusToolsRequestGuard)
@Controller('v3/media/campus-tools/:campusId/:catalogId/:entryId/:bindingId')
export class CampusToolsMediaController {
  constructor(
    @Inject(CampusToolsMediaService)
    private readonly media: CampusToolsMediaService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readCampusToolMediaDescriptor',
    security: [{}, { accessToken: [] }],
  })
  @ApiOkResponse({ standardSchema: campusToolMediaDescriptorSchema })
  descriptor(
    @Headers('authorization') auth: unknown,
    @Param('campusId', idOptions) campusId: string,
    @Param('catalogId', idOptions) catalogId: string,
    @Param('entryId', idOptions) entryId: string,
    @Param('bindingId', idOptions) bindingId: string,
    @Query({
      schema: emptyToolQuery,
      pipes: [new SchemaValidationPipe(emptyToolQuery)],
    })
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyToolBody)) _body: unknown,
  ) {
    return this.media.descriptor(credential(auth), {
      campusId,
      catalogId,
      entryId,
      bindingId,
    });
  }
  @Get(':variant')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readCampusToolMediaVariant',
    security: [{}, { accessToken: [] }],
    description:
      'Dedicated campus-tools owner, exact immutable measured variant, current authority before and after storage; no raw URL.',
  })
  @ApiOkResponse({
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
    },
  })
  async open(
    @Headers('authorization') auth: unknown,
    @Headers('range') range: string | undefined,
    @Param('campusId', idOptions) campusId: string,
    @Param('catalogId', idOptions) catalogId: string,
    @Param('entryId', idOptions) entryId: string,
    @Param('bindingId', idOptions) bindingId: string,
    @Param('variant', {
      schema: mediaVariantSchema,
      pipes: [new SchemaValidationPipe(mediaVariantSchema)],
    })
    variant: MediaVariantName,
    @Query({
      schema: emptyToolQuery,
      pipes: [new SchemaValidationPipe(emptyToolQuery)],
    })
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyToolBody)) _body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const target = campusToolMediaTargetSchema.parse({
      campusId,
      catalogId,
      entryId,
      bindingId,
    });
    const result = await this.media.open(
      credential(auth),
      target,
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
