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
import { SchemaValidationPipe } from '../http/validation.js';
import { errandResponseHeaders, ErrandResponses } from '../http/errand-http.js';
import { bearerToken } from '../identity/tokens.js';
import { ErrandRequestGuard } from '../request-throttling/errand-request.guard.js';
import { ErrandsService } from './service.js';
import {
  errandIdSchema,
  errandEmptyQuerySchema,
  errandEmptyBodySchema,
  publishErrandSchema,
  errandCommandSchema,
  acceptErrandSchema,
  errandsQuerySchema,
  ownErrandsQuerySchema,
  errandReceiptSchema,
  errandPageSchema,
  errandDetailSchema,
  errandContactHistorySchema,
} from './contracts.js';
import type {
  PublishErrand,
  ErrandCommand,
  AcceptErrand,
  ErrandsQuery,
  OwnErrandsQuery,
} from './contracts.js';
@ApiTags('Errands')
@ApiBearerAuth('accessToken')
@ErrandResponses()
@UseGuards(ErrandRequestGuard)
@Controller('v1')
export class ErrandsController {
  constructor(
    @Inject(ErrandsService) private readonly errands: ErrandsService,
  ) {}
  @Post('errands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'publishErrand',
    description:
      'Text-only, exact reviewed publication; both publisher contacts required. Cross-region target supported. No payment or provider call.',
  })
  @ApiOkResponse({
    standardSchema: errandReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict errand contract',
  })
  publish(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: publishErrandSchema,
      pipes: [new SchemaValidationPipe(publishErrandSchema)],
    })
    body: PublishErrand,
  ) {
    void query;
    return this.errands.publish(bearerToken(auth), body);
  }
  @Get('errands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listErrands',
    description:
      'Three-day discovery; identity-home all eligible, foreign and related regions own publications only. Bounded sparse keyset pages may be empty with more. Five-minute continuation window.',
  })
  @ApiOkResponse({
    standardSchema: errandPageSchema,
    headers: errandResponseHeaders,
    description: 'Strict errand contract',
  })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: errandsQuerySchema,
      pipes: [new SchemaValidationPipe(errandsQuerySchema)],
    })
    query: ErrandsQuery,
    @Body(new SchemaValidationPipe(errandEmptyBodySchema)) _body: unknown,
  ) {
    return this.errands.list(bearerToken(auth), query);
  }
  @Get('me/errands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listOwnErrands',
    description:
      'Own published or accepted relationships across all ages, regions and states; excludes tombstones. Current campus is not required.',
  })
  @ApiOkResponse({
    standardSchema: errandPageSchema,
    headers: errandResponseHeaders,
    description: 'Strict errand contract',
  })
  own(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ownErrandsQuerySchema,
      pipes: [new SchemaValidationPipe(ownErrandsQuerySchema)],
    })
    query: OwnErrandsQuery,
    @Body(new SchemaValidationPipe(errandEmptyBodySchema)) _body: unknown,
  ) {
    return this.errands.own(bearerToken(auth), query);
  }
  @Get('me/errands/contact-history')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readErrandContactHistory',
    description:
      'Owner-only remembered contacts from successful acceptance only.',
  })
  @ApiOkResponse({
    standardSchema: errandContactHistorySchema,
    headers: errandResponseHeaders,
    description: 'Strict errand contract',
  })
  contacts(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body(new SchemaValidationPipe(errandEmptyBodySchema)) _body: unknown,
  ) {
    void query;
    return this.errands.contacts(bearerToken(auth));
  }
  @Get('me/errand-requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readErrandReceipt',
    description:
      'Current active owner session only; exact immutable private-free outcome. Does not authorize content or contacts.',
  })
  @ApiOkResponse({
    standardSchema: errandReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict errand contract',
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    id: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body(new SchemaValidationPipe(errandEmptyBodySchema)) _body: unknown,
  ) {
    void query;
    return this.errands.receipt(bearerToken(auth), id);
  }
  @Get('errands/:orderId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readErrand',
    description:
      'Persistent participant private text. Opposite contacts only in currently accepted state. Nonparticipants need base eligibility; no region or age gate.',
  })
  @ApiOkResponse({
    standardSchema: errandDetailSchema,
    headers: errandResponseHeaders,
    description: 'Strict errand contract',
  })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('orderId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    id: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body(new SchemaValidationPipe(errandEmptyBodySchema)) _body: unknown,
  ) {
    void query;
    return this.errands.detail(bearerToken(auth), id);
  }
  @Post('errands/:orderId/accept')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'acceptErrand',
    description:
      'Atomic versioned, recoverable command; identical request replays, conflicting intent rejects. Acceptance is single-winner and cross-region; publisher alone cancels/completes/soft-deletes.',
  })
  @ApiOkResponse({
    standardSchema: errandReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict errand contract',
  })
  accept(
    @Headers('authorization') auth: unknown,
    @Param('orderId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    id: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: acceptErrandSchema,
      pipes: [new SchemaValidationPipe(acceptErrandSchema)],
    })
    body: AcceptErrand,
  ) {
    void query;
    return this.errands.command(bearerToken(auth), id, 'accept', body);
  }
  @Post('errands/:orderId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'cancelErrand',
    description:
      'Atomic versioned, recoverable command; identical request replays, conflicting intent rejects. Acceptance is single-winner and cross-region; publisher alone cancels/completes/soft-deletes.',
  })
  @ApiOkResponse({
    standardSchema: errandReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict errand contract',
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('orderId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    id: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: errandCommandSchema,
      pipes: [new SchemaValidationPipe(errandCommandSchema)],
    })
    body: ErrandCommand,
  ) {
    void query;
    return this.errands.command(bearerToken(auth), id, 'cancel', body);
  }
  @Post('errands/:orderId/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'completeErrand',
    description:
      'Atomic versioned, recoverable command; identical request replays, conflicting intent rejects. Acceptance is single-winner and cross-region; publisher alone cancels/completes/soft-deletes.',
  })
  @ApiOkResponse({
    standardSchema: errandReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict errand contract',
  })
  complete(
    @Headers('authorization') auth: unknown,
    @Param('orderId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    id: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: errandCommandSchema,
      pipes: [new SchemaValidationPipe(errandCommandSchema)],
    })
    body: ErrandCommand,
  ) {
    void query;
    return this.errands.command(bearerToken(auth), id, 'complete', body);
  }
  @Post('errands/:orderId/delete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'deleteErrand',
    description:
      'Atomic versioned, recoverable command; identical request replays, conflicting intent rejects. Acceptance is single-winner and cross-region; publisher alone cancels/completes/soft-deletes.',
  })
  @ApiOkResponse({
    standardSchema: errandReceiptSchema,
    headers: errandResponseHeaders,
    description: 'Strict errand contract',
  })
  delete(
    @Headers('authorization') auth: unknown,
    @Param('orderId', {
      schema: errandIdSchema,
      pipes: [new SchemaValidationPipe(errandIdSchema)],
    })
    id: string,
    @Query({
      schema: errandEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(errandEmptyQuerySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: errandCommandSchema,
      pipes: [new SchemaValidationPipe(errandCommandSchema)],
    })
    body: ErrandCommand,
  ) {
    void query;
    return this.errands.command(bearerToken(auth), id, 'delete', body);
  }
}
