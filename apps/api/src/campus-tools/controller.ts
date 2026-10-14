import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SchemaValidationPipe } from '../http/validation.js';
import { bearerToken } from '../identity/tokens.js';
import { CampusToolsService } from './service.js';
import { CampusToolsRequestGuard } from './request-guard.js';
import { toolId } from './contracts.js';
import {
  toolsHubSchema,
  toolDetailSchema,
  toolLinkSchema,
  emptyToolQuery,
  emptyToolBody,
  toolDetailQuery,
  toolLinkQuery,
} from './public-contracts.js';
const idOptions = { schema: toolId, pipes: [new SchemaValidationPipe(toolId)] };
const credential = (auth: unknown) =>
  auth === undefined ? null : bearerToken(auth);
@ApiTags('Campus tools')
@UseGuards(CampusToolsRequestGuard)
@Controller('v1/campuses/:campusId/tools')
export class CampusToolsController {
  constructor(
    @Inject(CampusToolsService) private readonly tools: CampusToolsService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readCampusTools',
    security: [{}, { accessToken: [] }],
    description:
      'Current accepted physical-campus tools. Guest browse never downgrades a supplied invalid credential. No historic source is seeded.',
  })
  @ApiOkResponse({ standardSchema: toolsHubSchema })
  hub(
    @Headers('authorization') auth: unknown,
    @Param('campusId', idOptions) campusId: string,
    @Query({
      schema: emptyToolQuery,
      pipes: [new SchemaValidationPipe(emptyToolQuery)],
    })
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyToolBody)) _body: unknown,
  ) {
    return this.tools.hub(credential(auth), campusId);
  }
  @Get(':entryId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readCampusTool',
    security: [{}, { accessToken: [] }],
  })
  @ApiOkResponse({ standardSchema: toolDetailSchema })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('campusId', idOptions) campusId: string,
    @Param('entryId', idOptions) entryId: string,
    @Query({
      schema: toolDetailQuery,
      pipes: [new SchemaValidationPipe(toolDetailQuery)],
    })
    query: { catalogId: string },
    @Body(new SchemaValidationPipe(emptyToolBody)) _body: unknown,
  ) {
    return this.tools.detail(
      credential(auth),
      campusId,
      entryId,
      query.catalogId,
    );
  }
  @Get(':entryId/link')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'resolveCampusToolLink',
    security: [{}, { accessToken: [] }],
    description:
      'Explicit exact current catalog action. Copy authority never grants webview embedding. No arbitrary destination parameter.',
  })
  @ApiOkResponse({ standardSchema: toolLinkSchema })
  link(
    @Headers('authorization') auth: unknown,
    @Param('campusId', idOptions) campusId: string,
    @Param('entryId', idOptions) entryId: string,
    @Query({
      schema: toolLinkQuery,
      pipes: [new SchemaValidationPipe(toolLinkQuery)],
    })
    query: { catalogId: string; action: 'copy' | 'webview' },
    @Body(new SchemaValidationPipe(emptyToolBody)) _body: unknown,
  ) {
    return this.tools.link(
      credential(auth),
      campusId,
      entryId,
      query.catalogId,
      query.action,
    );
  }
}
