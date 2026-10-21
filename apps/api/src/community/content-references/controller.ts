import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { ContentReferenceService } from './service.js';
import {
  referenceCapabilitySchema,
  referenceDestinationSchema,
  referenceEmptyBodySchema,
  referenceEmptyQuerySchema,
  referenceLookupResultSchema,
  referenceLookupSchema,
  referenceResolveSchema,
} from './contracts.js';
import type { ReferenceLookup, ReferenceResolve } from './contracts.js';

@ApiTags('Community content references')
@ApiBearerAuth('accessToken')
@Controller('v1/community/content-references')
export class ContentReferenceController {
  constructor(
    @Inject(ContentReferenceService)
    private readonly references: ContentReferenceService,
  ) {}
  @Get('capability')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'communityContentReferenceCapability' })
  @ApiOkResponse({ standardSchema: referenceCapabilitySchema })
  capability(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(referenceEmptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(referenceEmptyBodySchema)) _body: unknown,
  ) {
    return this.references.capability(bearerToken(auth));
  }
  @Post('resolve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'communityContentReferenceResolve' })
  @ApiOkResponse({ standardSchema: referenceDestinationSchema })
  resolve(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: referenceResolveSchema,
      pipes: [new SchemaValidationPipe(referenceResolveSchema)],
    })
    input: ReferenceResolve,
    @Query(new SchemaValidationPipe(referenceEmptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.references.resolve(bearerToken(auth), input);
  }
  @Post('lookup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'communityContentReferenceLookup' })
  @ApiOkResponse({ standardSchema: referenceLookupResultSchema })
  lookup(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: referenceLookupSchema,
      pipes: [new SchemaValidationPipe(referenceLookupSchema)],
    })
    input: ReferenceLookup,
    @Query(new SchemaValidationPipe(referenceEmptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.references.lookup(bearerToken(auth), input);
  }
}
