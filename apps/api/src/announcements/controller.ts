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
import { AnnouncementRequestGuard } from '../request-throttling/announcement-request.guard.js';
import { optionalAnnouncementBearer } from './access.js';
import { AnnouncementsService } from './service.js';
import {
  announcementIdSchema,
  announcementScopeQuerySchema,
  announcementListQuerySchema,
  announcementChangesQuerySchema,
  announcementEmptyBodySchema,
  announcementEmptyQuerySchema,
  announcementAckCommandSchema,
  announcementPageSchema,
  announcementDetailSchema,
  announcementPublicPopupSchema,
  announcementOwnerPopupSchema,
  announcementChangesSchema,
  announcementAckReceiptSchema,
} from './contracts.js';
import type {
  AnnouncementScopeQuery,
  AnnouncementListQuery,
  AnnouncementChangesQuery,
  AnnouncementAckCommand,
} from './contracts.js';
const headers = {
  'cache-control': { schema: { type: 'string' as const, enum: ['no-store'] } },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
function AnnouncementResponses() {
  return applyDecorators(
    ...[
      [
        400,
        'Strict input validation failed. Unknown/repeated keys and GET bodies are rejected.',
      ],
      [
        401,
        'Supplied bearer is invalid, expired or revoked; owner state requires authentication.',
      ],
      [
        403,
        'Current account or Safety restriction denies access. No phone/student verification gate.',
      ],
      [
        404,
        'ANNOUNCEMENT_NOT_FOUND or CAMPUS_NOT_FOUND. Withdrawn, foreign and missing announcement IDs share the same result.',
      ],
      [
        409,
        'DISCOVERY_RESTART_REQUIRED, ANNOUNCEMENT_REVISION_CHANGED or CAMPUS_UNAVAILABLE. Refresh current facts.',
      ],
      [413, 'Request exceeds the parser body-size limit.'],
      [415, 'Unsupported parser charset or encoding.'],
      [
        429,
        'RATE_LIMITED: shared account or guest request-IP announcement budget exhausted.',
      ],
      [
        503,
        'ANNOUNCEMENTS_UNAVAILABLE or SAFETY_UNAVAILABLE. Missing accepted coverage is not an empty catalog.',
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
const optionalSecurity = [{}, { accessToken: [] }];
@ApiTags('Announcements')
@AnnouncementResponses()
@UseGuards(AnnouncementRequestGuard)
@Controller('v1/announcements')
export class AnnouncementsController {
  constructor(
    @Inject(AnnouncementsService)
    private readonly announcements: AnnouncementsService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listAnnouncements',
    security: optionalSecurity,
    description:
      'Guest-capable current accepted content in stable source-ID-descending order. campusId is an explicit physical-campus browsing filter; omission means all-browsers only. Reads never acknowledge.',
  })
  @ApiOkResponse({
    standardSchema: announcementPageSchema,
    headers,
    description:
      'Current summaries with opaque revision/session/context-bound navigation.',
  })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: announcementListQuerySchema,
      pipes: [new SchemaValidationPipe(announcementListQuerySchema)],
    })
    query: AnnouncementListQuery,
    @Body(new SchemaValidationPipe(announcementEmptyBodySchema)) _body: unknown,
  ) {
    return this.announcements.list(optionalAnnouncementBearer(auth), query);
  }
  @Get('popup')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readLatestAnnouncementPopup',
    security: optionalSecurity,
    description:
      'Latest visible popup content, selected without consulting owner markers. Null means proven none in complete accepted coverage.',
  })
  @ApiOkResponse({
    standardSchema: announcementPublicPopupSchema,
    headers,
    description: 'Current latest popup or proven none; no owner state.',
  })
  popup(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: announcementScopeQuerySchema,
      pipes: [new SchemaValidationPipe(announcementScopeQuerySchema)],
    })
    query: AnnouncementScopeQuery,
    @Body(new SchemaValidationPipe(announcementEmptyBodySchema)) _body: unknown,
  ) {
    return this.announcements.popup(optionalAnnouncementBearer(auth), query);
  }
  @Get('changes')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readAnnouncementChanges',
    security: optionalSecurity,
    description:
      'Exact current created_at > since count at PostgreSQL microsecond precision. Omitted since is DB checkedAt minus 720 hours. Decimal-string count is recent publication, never unread; no watermark is stored. Missing temporal coverage or count budget exhaustion returns unavailable newness.',
  })
  @ApiOkResponse({
    standardSchema: announcementChangesSchema,
    headers,
    description:
      'Exact newness observation with independent unavailable state.',
  })
  changes(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: announcementChangesQuerySchema,
      pipes: [new SchemaValidationPipe(announcementChangesQuerySchema)],
    })
    query: AnnouncementChangesQuery,
    @Body(new SchemaValidationPipe(announcementEmptyBodySchema)) _body: unknown,
  ) {
    return this.announcements.changes(optionalAnnouncementBearer(auth), query);
  }
  @Get(':announcementId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readAnnouncement',
    security: optionalSecurity,
    description:
      'Current visible plain-text detail. Preserves paragraph/indentation text. Media is known empty or unavailable; no raw media links, actors or acknowledgement side effects.',
  })
  @ApiOkResponse({
    standardSchema: announcementDetailSchema,
    headers,
    description:
      'Current accepted detail, including catalog-wide latest designation.',
  })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('announcementId', {
      schema: announcementIdSchema,
      pipes: [new SchemaValidationPipe(announcementIdSchema)],
    })
    id: string,
    @Query({
      schema: announcementScopeQuerySchema,
      pipes: [new SchemaValidationPipe(announcementScopeQuerySchema)],
    })
    query: AnnouncementScopeQuery,
    @Body(new SchemaValidationPipe(announcementEmptyBodySchema)) _body: unknown,
  ) {
    return this.announcements.detail(
      optionalAnnouncementBearer(auth),
      id,
      query,
    );
  }
}
@ApiTags('Announcements')
@ApiBearerAuth('accessToken')
@AnnouncementResponses()
@UseGuards(AnnouncementRequestGuard)
@Controller('v1/me/announcements')
export class OwnAnnouncementsController {
  constructor(
    @Inject(AnnouncementsService)
    private readonly announcements: AnnouncementsService,
  ) {}
  @Get('popup')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readOwnAnnouncementPopup',
    description:
      'Atomic latest visible popup plus own ID-keyed marker. Only unseen permits automatic popup; acknowledged latest never falls back to older unseen. Unaccepted historical absence is unavailable.',
  })
  @ApiOkResponse({
    standardSchema: announcementOwnerPopupSchema,
    headers,
    description: 'Own current popup state without any read side effect.',
  })
  popup(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: announcementScopeQuerySchema,
      pipes: [new SchemaValidationPipe(announcementScopeQuerySchema)],
    })
    query: AnnouncementScopeQuery,
    @Body(new SchemaValidationPipe(announcementEmptyBodySchema)) _body: unknown,
  ) {
    return this.announcements.ownerPopup(bearerToken(auth), query);
  }
  @Put(':announcementId/popup-acknowledgement')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'acknowledgeAnnouncementPopup',
    description:
      'Explicit automatic-popup close command. Current visible active popup and exact revision are required; it need not remain newest. Append-only owner+announcement-ID marker and original server timestamp are replay stable, including across accepted edits and campus changes. Never updates counters, watermarks, rewards or notices.',
  })
  @ApiOkResponse({
    standardSchema: announcementAckReceiptSchema,
    headers,
    description:
      'Stable acknowledged receipt; only trusted historical timestamps may be null.',
  })
  acknowledge(
    @Headers('authorization') auth: unknown,
    @Param('announcementId', {
      schema: announcementIdSchema,
      pipes: [new SchemaValidationPipe(announcementIdSchema)],
    })
    id: string,
    @Query({
      schema: announcementEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(announcementEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: announcementAckCommandSchema,
      pipes: [new SchemaValidationPipe(announcementAckCommandSchema)],
    })
    command: AnnouncementAckCommand,
  ) {
    return this.announcements.acknowledge(bearerToken(auth), id, command);
  }
}
