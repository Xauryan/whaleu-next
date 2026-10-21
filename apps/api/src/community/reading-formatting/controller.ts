import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import type { AuthorMode, Category } from '../contracts.js';
import { textSourceCapabilitiesQuerySchema } from '../text-source/controller.js';
import { readingCapabilitySchema } from './capability.js';
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
import { bearerToken } from '../../identity/tokens.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import type { ContentKind } from '../content-review/contracts.js';
import {
  textSourceIdSchema,
  textSourceKindSchema,
  textSourceEmptyQuerySchema,
} from '../text-source/protocol.js';
import { TextSourceReadService } from '../text-source/read.service.js';
import { textSourceReadV2Schema } from './reader.js';
@ApiTags('Community immutable text source')
@ApiBearerAuth('accessToken')
@Controller('v2/community')
export class ReadingFormattingController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(TextSourceReadService)
    private readonly sources: TextSourceReadService,
  ) {}
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'communityTextSourceCapabilitiesV2',
    description:
      'Source capability remains independent. Formatter schema is verified; requested worker mode is configuration intent, never observed worker liveness.',
  })
  @ApiOkResponse({ standardSchema: readingCapabilitySchema })
  @Get('text-source-capabilities')
  capabilities(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(textSourceCapabilitiesQuerySchema))
    query: { spaceId: string; category: Category; authorMode: AuthorMode },
  ) {
    return this.sources.capabilitiesV2(
      bearerToken(auth),
      query.spaceId,
      query.category,
      query.authorMode,
      this.config.COMMUNITY_READING_FORMATTING_PROCESSING,
    );
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'communityTextSourceV2',
    description:
      'Canonical source is mandatory. Deterministic lossless presentation is optional and never changes reader authority.',
  })
  @ApiOkResponse({ standardSchema: textSourceReadV2Schema })
  @Get('text-sources/:kind/:id')
  source(
    @Headers('authorization') auth: unknown,
    @Param('kind', new SchemaValidationPipe(textSourceKindSchema))
    kind: ContentKind,
    @Param('id', new SchemaValidationPipe(textSourceIdSchema)) id: string,
    @Query(new SchemaValidationPipe(textSourceEmptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.sources.sourceV2(bearerToken(auth), kind, id);
  }
}
