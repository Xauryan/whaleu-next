import {
  Body,
  Controller,
  Get,
  Post,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SchemaValidationPipe } from '../http/validation.js';
import { errandResponseHeaders, ErrandResponses } from '../http/errand-http.js';
import { bearerToken } from '../identity/tokens.js';
import { ErrandRequestGuard } from '../request-throttling/errand-request.guard.js';
import { errandIdSchema, errandEmptyQuerySchema } from './contracts.js';
import { z } from 'zod';
import { ErrandAdminCommandService } from './admin-command-service.js';
import { ErrandRestrictionService } from './restriction-service.js';
import {
  adminDeleteErrandSchema,
  restrictErrandAccepterSchema,
  issueErrandRestrictionSchema,
  releaseErrandRestrictionSchema,
  errandAdminReceiptSchema,
  errandRestrictionReceiptSchema,
  errandRestrictionsQuerySchema,
  errandRestrictionHistoryQuerySchema,
  errandRestrictionsPageSchema,
  errandRestrictionHistorySchema,
} from './admin-command-contracts.js';
import type {
  AdminDeleteErrand,
  RestrictErrandAccepter,
  IssueErrandRestriction,
  ReleaseErrandRestriction,
  ErrandRestrictionsQuery,
  ErrandRestrictionHistoryQuery,
} from './admin-command-contracts.js';
@ApiTags('Errand administration')
@ApiBearerAuth('accessToken')
@ErrandResponses()
@UseGuards(ErrandRequestGuard)
@Controller('v1/admin')
export class ErrandAdminCommandController {
  constructor(
    @Inject(ErrandAdminCommandService)
    private readonly scoped: ErrandAdminCommandService,
    @Inject(ErrandRestrictionService)
    private readonly restrictions: ErrandRestrictionService,
  ) {}
  @Post('errands/:orderId/delete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'deleteAdminErrand',
    description:
      'Exact target administrative soft deletion preserving original lifecycle. Optional publisher restriction is atomic, global across regions and requires a nonempty reason. Self deletion uses the owner command.',
  })
  @ApiOkResponse({
    standardSchema: errandAdminReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict authorized administrative contract',
  })
  deleteAdminErrand(
    @Headers('authorization') auth: unknown,
    @Param('orderId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    orderId: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: adminDeleteErrandSchema,
      pipes: [new SchemaValidationPipe(adminDeleteErrandSchema)],
    })
    body: AdminDeleteErrand,
  ) {
    void query;
    return this.scoped.delete(bearerToken(auth), orderId, body);
  }
  @Post('errands/:orderId/restrict-accepter')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'restrictAdminErrandAccepter',
    description:
      'Exact target accepted/completed stored accepter only. Restriction affects publication and acceptance across every region; order lifecycle and revision remain unchanged.',
  })
  @ApiOkResponse({
    standardSchema: errandAdminReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict authorized administrative contract',
  })
  restrictAdminErrandAccepter(
    @Headers('authorization') auth: unknown,
    @Param('orderId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    orderId: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: restrictErrandAccepterSchema,
      pipes: [new SchemaValidationPipe(restrictErrandAccepterSchema)],
    })
    body: RestrictErrandAccepter,
  ) {
    void query;
    return this.scoped.restrictAccepter(bearerToken(auth), orderId, body);
  }
  @Get('errand-requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'getAdminErrandReceipt',
    description:
      'Own immutable administrative receipt with freshly revalidated current exact-target management authority. No private body or current participant disclosure.',
  })
  @ApiOkResponse({
    standardSchema: errandAdminReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict authorized administrative contract',
  })
  getAdminErrandReceipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    requestId: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body(new SchemaValidationPipe(z.undefined())) _body: unknown,
  ) {
    void query;
    return this.scoped.receipt(bearerToken(auth), requestId);
  }
  @Post('errand-restrictions')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'issueErrandRestriction',
    description:
      'Global management only. Issues an account-wide action restriction against an exact public profile reference, replacing effective same-action facts only.',
  })
  @ApiOkResponse({
    standardSchema: errandRestrictionReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict authorized administrative contract',
  })
  issueErrandRestriction(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: issueErrandRestrictionSchema,
      pipes: [new SchemaValidationPipe(issueErrandRestrictionSchema)],
    })
    body: IssueErrandRestriction,
  ) {
    void query;
    return this.restrictions.issue(bearerToken(auth), body);
  }
  @Post('errand-restrictions/:restrictionId/release')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'releaseErrandRestriction',
    description:
      'Global management only. Releases this exact active restriction, preserving independent restrictions and history. Does not promise complete feature eligibility.',
  })
  @ApiOkResponse({
    standardSchema: errandRestrictionReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict authorized administrative contract',
  })
  releaseErrandRestriction(
    @Headers('authorization') auth: unknown,
    @Param('restrictionId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    restrictionId: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: releaseErrandRestrictionSchema,
      pipes: [new SchemaValidationPipe(releaseErrandRestrictionSchema)],
    })
    body: ReleaseErrandRestriction,
  ) {
    void query;
    return this.restrictions.release(bearerToken(auth), restrictionId, body);
  }
  @Get('errand-restriction-requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'getErrandRestrictionReceipt',
    description:
      'Own global command receipt after fresh global authorization. Replay never reissues effects or requires the subject to retain its former eligibility.',
  })
  @ApiOkResponse({
    standardSchema: errandRestrictionReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict authorized administrative contract',
  })
  getErrandRestrictionReceipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    requestId: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body(new SchemaValidationPipe(z.undefined())) _body: unknown,
  ) {
    void query;
    return this.restrictions.receipt(bearerToken(auth), requestId);
  }
  @Get('errand-restrictions')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listErrandRestrictions',
    description:
      'Global management only. Bounded recorded restriction corpus with exact recordedTotal or unavailable. All-time historical coverage remains unknown. Time/source changes invalidate continuation; no private participant fields.',
  })
  @ApiOkResponse({
    standardSchema: errandRestrictionsPageSchema,
    headers: errandResponseHeaders,
    description: 'Strict authorized administrative contract',
  })
  listErrandRestrictions(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: errandRestrictionsQuerySchema,
      pipes: [new SchemaValidationPipe(errandRestrictionsQuerySchema)],
    })
    query: ErrandRestrictionsQuery,
    @Body(new SchemaValidationPipe(z.undefined())) _body: unknown,
  ) {
    return this.restrictions.list(bearerToken(auth), query);
  }
  @Get('errand-restrictions/:restrictionId/history')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'getErrandRestrictionHistory',
    description:
      'Global management only. Bounded immutable causal recorded events. Baseline enrollment is observation, never fabricated issuance; expiration is derived from finite end, not a synthetic administrator event.',
  })
  @ApiOkResponse({
    standardSchema: errandRestrictionHistorySchema,
    headers: errandResponseHeaders,
    description: 'Strict authorized administrative contract',
  })
  getErrandRestrictionHistory(
    @Headers('authorization') auth: unknown,
    @Param('restrictionId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    restrictionId: string,
    @Query({
      schema: errandRestrictionHistoryQuerySchema,
      pipes: [new SchemaValidationPipe(errandRestrictionHistoryQuerySchema)],
    })
    query: ErrandRestrictionHistoryQuery,
    @Body(new SchemaValidationPipe(z.undefined())) _body: unknown,
  ) {
    return this.restrictions.history(bearerToken(auth), restrictionId, query);
  }
}
