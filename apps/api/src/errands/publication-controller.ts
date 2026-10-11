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
import { SchemaValidationPipe } from '../http/validation.js';
import { errandResponseHeaders, ErrandResponses } from '../http/errand-http.js';
import { bearerToken } from '../identity/tokens.js';
import { ErrandRequestGuard } from '../request-throttling/errand-request.guard.js';
import {
  errandIdSchema,
  errandEmptyQuerySchema,
  errandEmptyBodySchema,
  errandReceiptSchema,
} from './contracts.js';
import {
  createErrandDraftSchema,
  cancelErrandDraftSchema,
  publishErrandV2Schema,
  errandDraftSchema,
  errandDraftCancellationSchema,
  errandPublicationPreparationSchema,
} from './publication-contracts.js';
import { ErrandPublicationService } from './publication-service.js';
const empty = {
  schema: errandEmptyQuerySchema,
  pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
};
const id = {
  schema: errandIdSchema,
  pipes: [new SchemaValidationPipe(errandIdSchema)],
};
const hash = z.strictObject({
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const recovery = z.union([
  errandPublicationPreparationSchema.extend({ state: z.literal('prepared') }),
  errandPublicationPreparationSchema.extend({
    state: z.literal('terminal'),
    receipt: errandReceiptSchema,
  }),
]);
@ApiTags('Errand publication')
@ApiBearerAuth('accessToken')
@ErrandResponses()
@UseGuards(ErrandRequestGuard)
@Controller('v2')
export class ErrandPublicationController {
  constructor(
    @Inject(ErrandPublicationService)
    private readonly publications: ErrandPublicationService,
  ) {}
  @Post('errand-drafts')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'createErrandMediaDraft',
    description:
      'Actor-owned immutable publication scope. No provider is activated.',
  })
  @ApiOkResponse({
    standardSchema: errandDraftSchema,
    headers: errandResponseHeaders,
  })
  create(
    @Headers('authorization') auth: unknown,
    @Query(empty) _query: unknown,
    @Body({
      schema: createErrandDraftSchema,
      pipes: [new SchemaValidationPipe(createErrandDraftSchema)],
    })
    body: unknown,
  ) {
    return this.publications.create(bearerToken(auth), body);
  }
  @Post('errand-publications/prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'prepareErrandPublication',
    description:
      'Freeze the original publication command and exact six-slot image set; returns metadata only. Does not approve or publish content.',
  })
  @ApiOkResponse({
    standardSchema: errandPublicationPreparationSchema,
    headers: errandResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(empty) _query: unknown,
    @Body({
      schema: publishErrandV2Schema,
      pipes: [new SchemaValidationPipe(publishErrandV2Schema)],
    })
    body: unknown,
  ) {
    return this.publications.prepare(bearerToken(auth), body);
  }
  @Post('errand-publications/:requestId/publish')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'publishErrandV2',
    description:
      'Publish only the original server-frozen command after exact business and whole-set image Review. Original v1 hashes and receipts remain unchanged.',
  })
  @ApiOkResponse({
    standardSchema: errandReceiptSchema,
    headers: errandResponseHeaders,
  })
  publish(
    @Headers('authorization') auth: unknown,
    @Param('requestId', id) requestId: string,
    @Query(empty) _query: unknown,
    @Body({ schema: hash, pipes: [new SchemaValidationPipe(hash)] })
    body: z.infer<typeof hash>,
  ) {
    return this.publications.publish(
      bearerToken(auth),
      requestId,
      body.requestHash,
    );
  }
  @Get('errand-publications/:requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'recoverErrandPublication',
    description:
      'Original actor metadata and immutable receipt only; does not grant image or contact access.',
  })
  @ApiOkResponse({ standardSchema: recovery, headers: errandResponseHeaders })
  recover(
    @Headers('authorization') auth: unknown,
    @Param('requestId', id) requestId: string,
    @Query(empty) _query: unknown,
    @Body(new SchemaValidationPipe(errandEmptyBodySchema)) _body: unknown,
  ) {
    return this.publications.recover(bearerToken(auth), requestId);
  }
  @Post('errand-drafts/:draftId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'cancelErrandMediaDraft',
    description:
      'Durably fence the original publication before freeing uncertain unbound uploads. Published orders and bound history cannot be cancelled here.',
  })
  @ApiOkResponse({
    standardSchema: errandDraftCancellationSchema,
    headers: errandResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('draftId', id) draftId: string,
    @Query(empty) _query: unknown,
    @Body({
      schema: cancelErrandDraftSchema,
      pipes: [new SchemaValidationPipe(cancelErrandDraftSchema)],
    })
    body: unknown,
  ) {
    return this.publications.cancel(bearerToken(auth), draftId, body);
  }
}
