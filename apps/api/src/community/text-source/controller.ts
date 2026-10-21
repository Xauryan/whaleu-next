import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
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
import { capabilitiesQuerySchema, authorModeSchema } from '../contracts.js';
import type { Category, AuthorMode } from '../contracts.js';
import type { ContentKind } from '../content-review/contracts.js';
import {
  textSourceIdSchema,
  textSourceKindSchema,
  textSourceReadSchema,
  textSourceCapabilitySchema,
  textSourceEmptyQuerySchema,
} from './protocol.js';
import { TextSourceReadService } from './read.service.js';

export const textSourceCapabilitiesQuerySchema = capabilitiesQuerySchema.extend(
  { authorMode: authorModeSchema },
);

/** Separate versioned routes. No legacy DTO acquires even an optional key. */
@ApiTags('Community immutable text source')
@ApiBearerAuth('accessToken')
@Controller('v1/community')
export class TextSourceController {
  constructor(
    @Inject(TextSourceReadService)
    private readonly sources: TextSourceReadService,
  ) {}
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'communityTextSourceCapabilities',
    description:
      'Explicit text-only source coverage requires current separately admitted local Review.',
  })
  @ApiOkResponse({ standardSchema: textSourceCapabilitySchema })
  @Get('text-source-capabilities')
  capabilities(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(textSourceCapabilitiesQuerySchema))
    query: { spaceId: string; category: Category; authorMode: AuthorMode },
  ) {
    return this.sources.capabilities(
      bearerToken(auth),
      query.spaceId,
      query.category,
      query.authorMode,
    );
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'communityTextSource',
    description:
      'Current canonical authorization and independent source evidence in one managed transaction. Denial has no source fallback.',
  })
  @ApiOkResponse({ standardSchema: textSourceReadSchema })
  @Get('text-sources/:kind/:id')
  source(
    @Headers('authorization') auth: unknown,
    @Param('kind', new SchemaValidationPipe(textSourceKindSchema))
    kind: ContentKind,
    @Param('id', new SchemaValidationPipe(textSourceIdSchema)) id: string,
    @Query(new SchemaValidationPipe(textSourceEmptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.sources.source(bearerToken(auth), kind, id);
  }
}
