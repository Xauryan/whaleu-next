import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { ActivityPublicationService } from './service.js';
import { ActivityPublicationRequestGuard } from './request-guard.js';
import {
  publicationId,
  publicationKey,
  publicationDigest,
  publicationQuerySchema,
  activityPublicationCommandSchema,
  activityPublicationResultSchema,
  activityPublicationRecoverySchema,
  activityDraftSchema,
  activityOrganizerPageSchema,
  activityNativeItemSchema,
  activityNativePageSchema,
} from './contracts.js';
import type {
  ActivityPublicationCommand,
  PublicationQuery,
} from './contracts.js';
const empty = z.strictObject({}),
  emptyBody = z.union([z.undefined(), empty]);
const eq = { schema: empty, pipes: [new SchemaValidationPipe(empty)] },
  eb = new SchemaValidationPipe(emptyBody);
const pq = {
  schema: publicationQuerySchema,
  pipes: [new SchemaValidationPipe(publicationQuerySchema)],
};
@ApiTags('Activity publication')
@ApiBearerAuth('accessToken')
@UseGuards(ActivityPublicationRequestGuard)
@Controller('v1/activity-publication')
export class ActivityPublicationController {
  constructor(
    @Inject(ActivityPublicationService)
    private readonly service: ActivityPublicationService,
  ) {}
  @Get('organizers')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listActivityPublicationOrganizers',
    description:
      'Current approved home-school organizations with real target owner/admin grants; legacy directory entries and school reviewer roles do not authorize publishing.',
  })
  @ApiOkResponse({ standardSchema: activityOrganizerPageSchema })
  organizers(
    @Headers('authorization') auth: unknown,
    @Query(pq) query: PublicationQuery,
    @Body(eb) _body: unknown,
  ) {
    return this.service.organizers(bearerToken(auth), query);
  }
  @Post('drafts/:activityId/commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'commandActivityPublication',
    description:
      'Account/draft isolated original-key commands. Publication freezes exact text/types/current organization/QR/media and enters independent review. Pending review must resume the original key and payload. No external production reviewer is enabled.',
  })
  @ApiOkResponse({ standardSchema: activityPublicationResultSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Param('activityId', {
      schema: publicationId,
      pipes: [new SchemaValidationPipe(publicationId)],
    })
    id: string,
    @Query(eq) _query: unknown,
    @Body({
      schema: activityPublicationCommandSchema,
      pipes: [new SchemaValidationPipe(activityPublicationCommandSchema)],
    })
    command: ActivityPublicationCommand,
  ) {
    return this.service.command(bearerToken(auth), id, command);
  }
  @Get('drafts/:activityId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'readOwnActivityDraft' })
  @ApiOkResponse({ standardSchema: activityDraftSchema })
  draft(
    @Headers('authorization') auth: unknown,
    @Param('activityId', {
      schema: publicationId,
      pipes: [new SchemaValidationPipe(publicationId)],
    })
    id: string,
    @Query(eq) _query: unknown,
    @Body(eb) _body: unknown,
  ) {
    return this.service.draft(bearerToken(auth), id);
  }
  @Get('requests/:requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'recoverActivityPublication' })
  @ApiOkResponse({ standardSchema: activityPublicationRecoverySchema })
  recover(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: publicationKey,
      pipes: [new SchemaValidationPipe(publicationKey)],
    })
    id: string,
    @Query(eq) _query: unknown,
    @Body(eb) _body: unknown,
  ) {
    return this.service.recover(bearerToken(auth), id);
  }
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'cancelActivityPublication' })
  @ApiOkResponse({ standardSchema: activityPublicationRecoverySchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: publicationKey,
      pipes: [new SchemaValidationPipe(publicationKey)],
    })
    id: string,
    @Query(eq) _query: unknown,
    @Body({
      schema: z.strictObject({ requestHash: publicationDigest }),
      pipes: [
        new SchemaValidationPipe(
          z.strictObject({ requestHash: publicationDigest }),
        ),
      ],
    })
    body: { requestHash: string },
  ) {
    return this.service.cancel(bearerToken(auth), id, body.requestHash);
  }
  @Get('catalog')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listNativeActivities',
    description:
      'Separately labelled native publication source. Does not replace, merge totals with, or rewrite accepted legacy catalogs.',
  })
  @ApiOkResponse({ standardSchema: activityNativePageSchema })
  list(
    @Headers('authorization') auth: unknown,
    @Query(pq) query: PublicationQuery,
    @Body(eb) _body: unknown,
  ) {
    return this.service.list(bearerToken(auth), query);
  }
  @Get('mine')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listOwnNativeActivities',
    description:
      'History belongs to the immutable original publisher, not the organization current owner.',
  })
  @ApiOkResponse({ standardSchema: activityNativePageSchema })
  mine(
    @Headers('authorization') auth: unknown,
    @Query(pq) query: PublicationQuery,
    @Body(eb) _body: unknown,
  ) {
    return this.service.list(bearerToken(auth), query, true);
  }
  @Get('activities/:activityId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'readNativeActivity' })
  @ApiOkResponse({ standardSchema: activityNativeItemSchema })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('activityId', {
      schema: publicationId,
      pipes: [new SchemaValidationPipe(publicationId)],
    })
    id: string,
    @Query(eq) _query: unknown,
    @Body(eb) _body: unknown,
  ) {
    return this.service.detail(bearerToken(auth), id);
  }
}
