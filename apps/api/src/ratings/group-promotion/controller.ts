import { PromotionRequestGuard } from './request-guard.js';
import {
  UseGuards,
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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiOkResponse,
  ApiAcceptedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { RatingGroupPromotionService } from './service.js';
import {
  campaignInput,
  cancelInput,
  intentInput,
  pageInput,
  previewInput,
  promotionId,
  reconcileInput,
  sealInput,
} from './contracts.js';
import * as operator from './operator.js';
export const RATING_GROUP_OPERATOR_RENDERER = Symbol(
  'RATING_GROUP_OPERATOR_RENDERER',
);
export const defaultRatingGroupOperatorRenderer = {
  shell: operator.renderRatingGroupPromotionOperatorShell,
  script: operator.ratingGroupPromotionOperatorModuleSource,
};
const response = z.record(z.string(), z.unknown());
const queryOptions = <T>(schema: z.ZodType<T>) => ({
  schema,
  pipes: [new SchemaValidationPipe(schema)],
});
@ApiTags('Rating group promotion')
@ApiBearerAuth('accessToken')
@UseGuards(PromotionRequestGuard)
@Controller('v1/rating-group-promotion')
export class RatingGroupPromotionController {
  constructor(
    @Inject(RatingGroupPromotionService)
    private readonly service: RatingGroupPromotionService,
  ) {}
  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionCapabilities' })
  @ApiOkResponse({ standardSchema: response })
  capabilities(
    @Headers('authorization') auth: unknown,
    @Query(queryOptions(z.strictObject({ programId: promotionId })))
    query: { programId: string },
  ) {
    return this.service.capabilities(bearerToken(auth), query.programId);
  }
  @Get('programs/:id')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionProgram' })
  @ApiOkResponse({ standardSchema: response })
  program(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
  ) {
    return this.service.inspectProgram(bearerToken(auth), id);
  }
  @Get('programs/:id/destinations')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionDestinations' })
  @ApiOkResponse({ standardSchema: response })
  destinations(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
    @Query(queryOptions(pageInput.extend({ kind: z.enum(['normal', 'test']) })))
    query: { kind: 'normal' | 'test'; cursor?: string },
  ) {
    return this.service.destinations(
      bearerToken(auth),
      id,
      query.kind,
      query.cursor,
    );
  }
  @Post('programs/:id/previews')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionPreview' })
  @ApiOkResponse({ standardSchema: response })
  preview(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
    @Body({
      schema: previewInput,
      pipes: [new SchemaValidationPipe(previewInput)],
    })
    body: z.infer<typeof previewInput>,
  ) {
    return this.service.preview(bearerToken(auth), id, body);
  }
  @Post('programs/:id/intents')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionIntent' })
  @ApiOkResponse({ standardSchema: response })
  intent(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
    @Body({
      schema: intentInput,
      pipes: [new SchemaValidationPipe(intentInput)],
    })
    body: z.infer<typeof intentInput>,
  ) {
    return this.service.intent(bearerToken(auth), id, body);
  }
  @Get('programs/:id/intents/:requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionIntentRecovery' })
  @ApiOkResponse({ standardSchema: response })
  recoverIntent(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
    @Param('requestId', new SchemaValidationPipe(promotionId)) request: string,
  ) {
    return this.service.recoverIntent(bearerToken(auth), id, request);
  }
  @Post('programs/:id/campaigns')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionAdmit' })
  @ApiAcceptedResponse({ standardSchema: response })
  campaign(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
    @Body({
      schema: campaignInput,
      pipes: [new SchemaValidationPipe(campaignInput)],
    })
    body: z.infer<typeof campaignInput>,
  ) {
    return this.service.campaign(bearerToken(auth), id, body);
  }
  @Get('programs/:id/requests/:requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionRequest' })
  @ApiOkResponse({ standardSchema: response })
  request(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
    @Param('requestId', new SchemaValidationPipe(promotionId)) request: string,
  ) {
    return this.service.request(bearerToken(auth), id, request);
  }
  @Post('programs/:id/requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionSeal' })
  @ApiOkResponse({ standardSchema: response })
  seal(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
    @Param('requestId', new SchemaValidationPipe(promotionId)) request: string,
    @Body({ schema: sealInput, pipes: [new SchemaValidationPipe(sealInput)] })
    body: z.infer<typeof sealInput>,
  ) {
    return this.service.seal(bearerToken(auth), id, request, body);
  }
  @Get('campaigns/:id')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionStatus' })
  @ApiOkResponse({ standardSchema: response })
  status(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
  ) {
    return this.service.status(bearerToken(auth), id);
  }
  @Get('campaigns/:id/recipients')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionRecipients' })
  @ApiOkResponse({ standardSchema: response })
  recipients(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
    @Query(queryOptions(pageInput))
    query: z.infer<typeof pageInput>,
  ) {
    return this.service.recipients(bearerToken(auth), id, query.cursor);
  }
  @Post('campaigns/:id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionCancel' })
  @ApiOkResponse({ standardSchema: response })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
    @Body({
      schema: cancelInput,
      pipes: [new SchemaValidationPipe(cancelInput)],
    })
    body: z.infer<typeof cancelInput>,
  ) {
    return this.service.cancelCampaign(bearerToken(auth), id, body.requestId);
  }
  @Post('campaigns/:id/reconcile')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingGroupPromotionReconcile' })
  @ApiAcceptedResponse({ standardSchema: response })
  reconcile(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(promotionId)) id: string,
    @Body({
      schema: reconcileInput,
      pipes: [new SchemaValidationPipe(reconcileInput)],
    })
    body: z.infer<typeof reconcileInput>,
  ) {
    return this.service.reconcile(bearerToken(auth), id, body.effectId);
  }
}
@Controller('operator/rating-group-promotion')
export class RatingGroupPromotionOperatorController {
  constructor(
    @Inject(RATING_GROUP_OPERATOR_RENDERER)
    private readonly renderer: typeof defaultRatingGroupOperatorRenderer,
  ) {}
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header(
    'Cache-Control',
    operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS['Cache-Control'],
  )
  @Header('Pragma', operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS.Pragma)
  @Header(
    'Content-Security-Policy',
    operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS['Content-Security-Policy'],
  )
  @Header(
    'Referrer-Policy',
    operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS['Referrer-Policy'],
  )
  @Header(
    'X-Content-Type-Options',
    operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS['X-Content-Type-Options'],
  )
  @Header(
    'Cross-Origin-Resource-Policy',
    operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS[
      'Cross-Origin-Resource-Policy'
    ],
  )
  @ApiOperation({ operationId: 'ratingGroupPromotionOperatorShell' })
  shell() {
    return this.renderer.shell();
  }
  @Get('controller.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header(
    'Cache-Control',
    operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS['Cache-Control'],
  )
  @Header('Pragma', operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS.Pragma)
  @Header(
    'Content-Security-Policy',
    operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS['Content-Security-Policy'],
  )
  @Header(
    'Referrer-Policy',
    operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS['Referrer-Policy'],
  )
  @Header(
    'X-Content-Type-Options',
    operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS['X-Content-Type-Options'],
  )
  @Header(
    'Cross-Origin-Resource-Policy',
    operator.RATING_GROUP_PROMOTION_OPERATOR_HEADERS[
      'Cross-Origin-Resource-Policy'
    ],
  )
  @ApiOperation({ operationId: 'ratingGroupPromotionOperatorScript' })
  script() {
    return this.renderer.script();
  }
}
