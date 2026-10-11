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
import { OrganizationService } from './service.js';
import { OrganizationRequestGuard } from './request-guard.js';
import {
  organizationIdSchema,
  organizationRequestIdSchema,
  organizationEmptyQuerySchema,
  organizationEmptyBodySchema,
  organizationListQuerySchema,
  organizationManagementQuerySchema,
  organizationLookupQuerySchema,
  createOrganizationSchema,
  saveOrganizationSchema,
  reviewOrganizationSchema,
  organizationMemberCommandSchema,
  organizationCancelSchema,
  organizationReceiptSchema,
  organizationRecoverySchema,
  organizationDetailSchema,
  organizationPublicDetailSchema,
  organizationListSchema,
  organizationPersonSchema,
} from './contracts.js';
import type {
  CreateOrganization,
  SaveOrganization,
  ReviewOrganization,
  OrganizationMemberCommand,
  OrganizationListQuery,
} from './contracts.js';
const reviewListQuery = organizationListQuerySchema.extend({
  regionId: organizationIdSchema.optional(),
});
const reviewQuery = z.strictObject({ regionId: organizationIdSchema });
const emptyQuery = {
  schema: organizationEmptyQuerySchema,
  pipes: [new SchemaValidationPipe(organizationEmptyQuerySchema)],
};
const idPipe = new SchemaValidationPipe(organizationIdSchema);
const emptyBody = new SchemaValidationPipe(organizationEmptyBodySchema);
@ApiTags('Organization management')
@ApiBearerAuth('accessToken')
@UseGuards(OrganizationRequestGuard)
@Controller('v1/organizations')
export class OrganizationController {
  constructor(
    @Inject(OrganizationService) private readonly service: OrganizationService,
  ) {}
  @Get('context')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'readOrganizationContext' })
  @ApiOkResponse({
    standardSchema: z.strictObject({ regionId: organizationIdSchema }),
  })
  context(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: unknown,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.service.context(bearerToken(auth));
  }
  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'readOrganizationReviewCapabilities' })
  @ApiOkResponse({
    standardSchema: z.strictObject({
      management: z.enum(['none', 'fixed', 'global']),
      region: z
        .strictObject({ id: organizationIdSchema, name: z.string() })
        .nullable(),
    }),
  })
  capabilities(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: unknown,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.service.capabilities(bearerToken(auth));
  }
  @Get('mine')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listOwnOrganizations',
    description:
      'Actual target-scoped management and own unapproved applications. Cosmetic titles and accepted directory snapshots never grant management.',
  })
  @ApiOkResponse({ standardSchema: organizationListSchema })
  mine(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: organizationListQuerySchema,
      pipes: [new SchemaValidationPipe(organizationListQuerySchema)],
    })
    query: OrganizationListQuery,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.service.list(bearerToken(auth), 'mine', undefined, query);
  }
  @Get('reviews')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listOrganizationApplications',
    description:
      'Fixed school-admin region, or explicit true-super-admin target region. Developer grants do not qualify.',
  })
  @ApiOkResponse({ standardSchema: organizationListSchema })
  reviews(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: reviewListQuery,
      pipes: [new SchemaValidationPipe(reviewListQuery)],
    })
    query: OrganizationListQuery & { regionId?: string },
    @Body(emptyBody) _body: unknown,
  ) {
    const { regionId, ...list } = query;
    return this.service.list(bearerToken(auth), 'review', regionId, list);
  }
  @Get('regions/:regionId/entries')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listNativeOrganizationDirectory',
    description:
      'Separately paginated native approval source. Does not claim legacy accepted coverage or totals. Current home-region gates and exact Media Review apply.',
  })
  @ApiOkResponse({ standardSchema: organizationListSchema })
  publicList(
    @Headers('authorization') auth: unknown,
    @Param('regionId', idPipe) regionId: string,
    @Query({
      schema: organizationListQuerySchema,
      pipes: [new SchemaValidationPipe(organizationListQuerySchema)],
    })
    query: OrganizationListQuery,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.service.list(bearerToken(auth), 'public', regionId, query);
  }
  @Get('regions/:regionId/entries/:organizationId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readNativeOrganizationDirectoryEntry',
    description:
      'Native approved content only. Manager contact image, applicants and private account identifiers are never exposed.',
  })
  @ApiOkResponse({ standardSchema: organizationPublicDetailSchema })
  publicDetail(
    @Headers('authorization') auth: unknown,
    @Param('regionId', idPipe) regionId: string,
    @Param('organizationId', idPipe) id: string,
    @Query(emptyQuery) _query: unknown,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.service.publicDetail(bearerToken(auth), regionId, id);
  }
  @Get('requests/:requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'recoverOrganizationCommand',
    description:
      'Owner historical receipt only; replay never restores a revoked management grant.',
  })
  @ApiOkResponse({ standardSchema: organizationRecoverySchema })
  recover(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(organizationRequestIdSchema))
    id: string,
    @Query(emptyQuery) _query: unknown,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.service.recover(bearerToken(auth), id);
  }
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'cancelOrganizationCommand' })
  @ApiOkResponse({ standardSchema: organizationRecoverySchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(organizationRequestIdSchema))
    id: string,
    @Query(emptyQuery) _query: unknown,
    @Body({
      schema: organizationCancelSchema,
      pipes: [new SchemaValidationPipe(organizationCancelSchema)],
    })
    body: { requestHash: string },
  ) {
    return this.service.cancel(bearerToken(auth), id, body.requestHash);
  }
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'createOrganizationDraft',
    description:
      'Creates a real unprivileged applicant draft. All mandatory images must be uploaded and independently reviewed before submission.',
  })
  @ApiOkResponse({ standardSchema: organizationReceiptSchema })
  create(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: unknown,
    @Body({
      schema: createOrganizationSchema,
      pipes: [new SchemaValidationPipe(createOrganizationSchema)],
    })
    body: CreateOrganization,
  ) {
    return this.service.create(bearerToken(auth), body);
  }
  @Get(':organizationId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'readOrganizationManagement' })
  @ApiOkResponse({ standardSchema: organizationDetailSchema })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('organizationId', idPipe) id: string,
    @Query(emptyQuery) _query: unknown,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.service.detail(bearerToken(auth), id);
  }
  @Get(':organizationId/members/lookup')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'findOrganizationMember',
    description:
      'Exact existing public profile identifier, revalidated against the organization own region. No guessed numeric legacy UID mapping.',
  })
  @ApiOkResponse({ standardSchema: organizationPersonSchema })
  lookup(
    @Headers('authorization') auth: unknown,
    @Param('organizationId', idPipe) id: string,
    @Query({
      schema: organizationLookupQuerySchema,
      pipes: [new SchemaValidationPipe(organizationLookupQuerySchema)],
    })
    query: { profileId: string },
    @Body(emptyBody) _body: unknown,
  ) {
    return this.service.lookup(bearerToken(auth), id, query.profileId);
  }
  @Post(':organizationId/content')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'saveOrganizationContent',
    description:
      'Exact revision and authority-version CAS. Approved edits preserve approved status as in legacy; every replaced image still requires independent current Safety Review.',
  })
  @ApiOkResponse({ standardSchema: organizationReceiptSchema })
  save(
    @Headers('authorization') auth: unknown,
    @Param('organizationId', idPipe) id: string,
    @Query(emptyQuery) _query: unknown,
    @Body({
      schema: saveOrganizationSchema,
      pipes: [new SchemaValidationPipe(saveOrganizationSchema)],
    })
    body: SaveOrganization,
  ) {
    return this.service.save(bearerToken(auth), id, body);
  }
  @Post(':organizationId/review')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'reviewOrganizationApplication',
    description:
      'First approval atomically grants the sole owner role to the actual applicant. Reject requires a reason. Business approval cannot replace image Safety Review.',
  })
  @ApiOkResponse({ standardSchema: organizationReceiptSchema })
  review(
    @Headers('authorization') auth: unknown,
    @Param('organizationId', idPipe) id: string,
    @Query({
      schema: reviewQuery,
      pipes: [new SchemaValidationPipe(reviewQuery)],
    })
    query: { regionId: string },
    @Body({
      schema: reviewOrganizationSchema,
      pipes: [new SchemaValidationPipe(reviewOrganizationSchema)],
    })
    body: ReviewOrganization,
  ) {
    return this.service.review(bearerToken(auth), id, query.regionId, body);
  }
  @Post(':organizationId/members')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'manageOrganizationMembers',
    description:
      'Owner/admin/school authority may add/remove administrators but never remove an owner. Transfer requires owner or exact school authority and atomically revokes the real previous owner.',
  })
  @ApiOkResponse({ standardSchema: organizationReceiptSchema })
  member(
    @Headers('authorization') auth: unknown,
    @Param('organizationId', idPipe) id: string,
    @Query(emptyQuery) _query: unknown,
    @Body({
      schema: organizationMemberCommandSchema,
      pipes: [new SchemaValidationPipe(organizationMemberCommandSchema)],
    })
    body: OrganizationMemberCommand,
  ) {
    return this.service.member(bearerToken(auth), id, body);
  }
}
void organizationManagementQuerySchema;
