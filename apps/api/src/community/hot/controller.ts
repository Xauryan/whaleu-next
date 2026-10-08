import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SchemaValidationPipe } from '../../http/validation.js';
import { safeErrorResponseSchema } from '../../http/error-contracts.js';
import { bearerToken } from '../../identity/tokens.js';
import { hotQuerySchema, hotEmptyBodySchema } from './contracts.js';
import type { HotQuery, HotPage } from './contracts.js';
import { hotPageSchema } from './response-schema.js';
import { HotFeedService } from './service.js';
const headers = {
  'cache-control': {
    schema: { type: 'string' as const, enum: ['private, no-store'] },
  },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
@ApiTags('Community hot feed')
@ApiResponse({
  status: 400,
  description: 'Strict explicit-space query or opaque cursor scope is invalid.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 401,
  description:
    'Supplied authentication is invalid or continuation needs a current session. Invalid supplied credentials never become guest access.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 403,
  description:
    'Current Safety policy or phone continuation permission is unavailable.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 409,
  description:
    'COMMUNITY_SCOPE_UNAVAILABLE: explicit space or owning region is inactive. DISCOVERY_RESTART_REQUIRED: cursor expired/evicted, or last visible post became inaccessible or structurally excluded. Score movement alone never requires restart.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 503,
  description:
    'HOT_FEED_UNAVAILABLE: processing disabled or bounded current proof timed out. Other owner unavailability remains distinct. Unknown heat coverage never becomes zero.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 500,
  description: 'Unexpected failure is sanitized.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@Controller('v1/community')
export class HotController {
  constructor(@Inject(HotFeedService) private readonly hot: HotFeedService) {}
  @Get('hot')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readCommunityHot',
    security: [{}, { accessToken: [] }],
    description:
      'One explicit current regional or global space; regional supported categories, global discussion only. Six rolling publication-age ranges: day 24h/cap50, week7d/cap200, month30d, half_year180d, year365d, history all ages (latter four cap1000). Inclusive age boundary; no future publication. Full independent native component coverage only, no historical-import claim. Unified cumulative score, with current visibility and normal/open trading only. No public score or numerical rank. Live numeric-keyset navigation may repeat or omit moving posts across pages; caps count delivered slots. Refresh resets navigation. First page accepts guests; further traversal needs current phone evidence. Empty bounded scan may continue via scan_pending. Public reads never settle or compute. Disabled default; manual_only is local acceptance without continuous maintenance.',
  })
  @ApiOkResponse({
    standardSchema: hotPageSchema,
    headers,
    description:
      'Current visible PostView projection, nullable opaque continuation. No count total or heat metadata.',
  })
  read(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: hotQuerySchema,
      pipes: [new SchemaValidationPipe(hotQuerySchema)],
    })
    query: HotQuery,
    @Body(new SchemaValidationPipe(hotEmptyBodySchema)) _body: unknown,
  ): Promise<HotPage> {
    return this.hot.read(auth === undefined ? null : bearerToken(auth), query);
  }
}
