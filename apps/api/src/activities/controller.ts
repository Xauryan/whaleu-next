import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SchemaValidationPipe } from '../http/validation.js';
import { safeErrorResponseSchema } from '../http/error-contracts.js';
import { bearerToken } from '../identity/tokens.js';
import { ActivityRequestGuard } from '../request-throttling/activity-request.guard.js';
import { ActivitiesService } from './service.js';
import {
  activityIdSchema,
  activityListQuerySchema,
  activityEmptyBodySchema,
  activityEmptyQuerySchema,
  activityVisitCommandSchema,
  activityContextSchema,
  activityPageSchema,
  activityDetailSchema,
  activityVisitReceiptSchema,
} from './contracts.js';
import type { ActivityListQuery, ActivityVisitCommand } from './contracts.js';
const headers = {
  'cache-control': { schema: { type: 'string' as const, enum: ['no-store'] } },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
function ActivityResponses() {
  return applyDecorators(
    ...[
      [
        400,
        'Strict validation: unknown/repeated input keys and GET bodies rejected.',
      ],
      [
        401,
        'Current valid owner bearer session required, including receipt replay.',
      ],
      [
        403,
        'Current phone/student/Safety/identity-home authority denies access. Administrator roles do not bypass these gates.',
      ],
      [
        404,
        'ACTIVITY_NOT_FOUND: missing, foreign, inactive and unpublished activity targets are indistinguishable.',
      ],
      [
        409,
        'DISCOVERY_RESTART_REQUIRED, ACTIVITY_REVISION_CHANGED or ACTIVITY_VISIT_CONFLICT. Refresh or review conflicting visit intent.',
      ],
      [413, 'Request exceeds body size limit.'],
      [415, 'Unsupported body encoding.'],
      [
        429,
        'RATE_LIMITED: shared validated-account activity budget exhausted.',
      ],
      [
        503,
        'ACTIVITY_UNAVAILABLE or ACTIVITY_ENTRY_SELECTION_UNAVAILABLE; unknown history is not empty. Explicit window=all is independent of entry selection. Owner verification/Safety/identity authority may also be unavailable.',
      ],
      [500, 'Unexpected failure is sanitized.'],
    ].map(([status, description]) =>
      ApiResponse({
        status: status as number,
        description: description as string,
        standardSchema: safeErrorResponseSchema,
        headers:
          status === 429
            ? {
                ...headers,
                'retry-after': { schema: { type: 'string', enum: ['60'] } },
              }
            : headers,
      }),
    ),
  );
}
@ApiTags('Activities')
@ApiBearerAuth('accessToken')
@ActivityResponses()
@UseGuards(ActivityRequestGuard)
@Controller('v1')
export class ActivitiesController {
  constructor(
    @Inject(ActivitiesService) private readonly activities: ActivitiesService,
  ) {}
  @Get('activities/context')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readActivityContext',
    description:
      'Current canonical identity-home region and accepted global visit history. No browsing-campus fallback, catalog claim or read side effect.',
  })
  @ApiOkResponse({
    standardSchema: activityContextSchema,
    headers,
    description: 'Current member identity-home context.',
  })
  context(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: activityEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(activityEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(activityEmptyBodySchema)) _body: unknown,
  ) {
    return this.activities.context(bearerToken(auth));
  }
  @Get('regions/:regionId/activities')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listActivities',
    description:
      'Current accepted member activity summaries. Entry selects all for accepted visited history, otherwise created strictly after one DB-clock anchor minus 72 hours, falling back to an explicit ten-history recommendation. Unknown history/time coverage is unavailable. Explicit all is uncapped bounded keyset pagination. Cursors freeze selection, even after visit acknowledgement; every page reauthorizes.',
  })
  @ApiOkResponse({
    standardSchema: activityPageSchema,
    headers,
    description:
      'Authorized catalog page; end is relative to the explicit selection.',
  })
  list(
    @Headers('authorization') auth: unknown,
    @Param('regionId', {
      schema: activityIdSchema,
      pipes: [new SchemaValidationPipe(activityIdSchema)],
    })
    regionId: string,
    @Query({
      schema: activityListQuerySchema,
      pipes: [new SchemaValidationPipe(activityListQuerySchema)],
    })
    query: ActivityListQuery,
    @Body(new SchemaValidationPipe(activityEmptyBodySchema)) _body: unknown,
  ) {
    return this.activities.list(bearerToken(auth), regionId, query);
  }
  @Get('regions/:regionId/activities/:activityId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readActivity',
    description:
      'Independent current-authorized plain-text detail. Does not trust a list/opener snapshot, acknowledge visits, fetch media or disclose publisher/manager/participant people.',
  })
  @ApiOkResponse({
    standardSchema: activityDetailSchema,
    headers,
    description: 'Exact accepted text and explicit unavailable media/facts.',
  })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('regionId', {
      schema: activityIdSchema,
      pipes: [new SchemaValidationPipe(activityIdSchema)],
    })
    regionId: string,
    @Param('activityId', {
      schema: activityIdSchema,
      pipes: [new SchemaValidationPipe(activityIdSchema)],
    })
    id: string,
    @Query({
      schema: activityEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(activityEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(activityEmptyBodySchema)) _body: unknown,
  ) {
    return this.activities.detail(bearerToken(auth), regionId, id);
  }
  @Put('me/activity-visits/:requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'recordActivityVisit',
    description:
      'Explicit successful-entry command, issued only after a decoded list is rendered in the active member page. Fresh requests require current member authority and exact catalog revision. Replay requires the current valid owner session and identical region/catalog intent; returns only original immutable receipt, even after catalog/campus changes. Never a per-item read proof or reminder subscription.',
  })
  @ApiOkResponse({
    standardSchema: activityVisitReceiptSchema,
    headers,
    description:
      'Stable minimal owner receipt with monotonically increasing DB-clock visit time.',
  })
  visit(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: activityIdSchema,
      pipes: [new SchemaValidationPipe(activityIdSchema)],
    })
    requestId: string,
    @Query({
      schema: activityEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(activityEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: activityVisitCommandSchema,
      pipes: [new SchemaValidationPipe(activityVisitCommandSchema)],
    })
    command: ActivityVisitCommand,
  ) {
    return this.activities.visit(bearerToken(auth), requestId, command);
  }
}
