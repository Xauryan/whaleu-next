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
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { bearerToken } from '../../identity/tokens.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import { ratingEmptySchema } from '../contracts.js';
import { RatingAssistanceService } from './service.js';
import * as C from './contracts.js';
const options = <T>(schema: z.ZodType<T>) => ({
  schema,
  pipes: [new SchemaValidationPipe(schema)],
});
const empty = options(ratingEmptySchema);
const emptyBody = new SchemaValidationPipe(
  z.union([z.undefined(), ratingEmptySchema]),
);
@ApiTags('Private rating assistance')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v2/ratings/assistance/requests')
export class RatingAssistanceController {
  constructor(
    @Inject(RatingAssistanceService)
    private readonly assistance: RatingAssistanceService,
  ) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingAssistanceCreate',
    description:
      'Admit an exact private suggestion. Synthetic-only and disabled by default; never publishes or approves content.',
  })
  @ApiOkResponse({
    standardSchema: C.assistanceMetadataSchema,
    headers: ratingResponseHeaders,
  })
  create(
    @Headers('authorization') auth: unknown,
    @Query(empty) _query: Record<string, never>,
    @Body(options(C.assistanceRequestSchema)) input: C.AssistanceRequest,
  ) {
    return this.assistance.create(bearerToken(auth), input);
  }
  @Get(':requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingAssistanceStatus',
    description:
      'Original-owner metadata only; does not dispatch or return cached plaintext.',
  })
  @ApiOkResponse({
    standardSchema: C.assistanceMetadataSchema,
    headers: ratingResponseHeaders,
  })
  status(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(C.assistanceRequestIdSchema))
    id: string,
    @Query(empty) _query: Record<string, never>,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.assistance.status(bearerToken(auth), id);
  }
  @Get(':requestId/result')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingAssistanceResult',
    description:
      'Freshly qualified short-lived literal suggestion. Never dispatches or retries a provider.',
  })
  @ApiOkResponse({
    standardSchema: C.assistanceResultSchema,
    headers: ratingResponseHeaders,
  })
  result(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(C.assistanceRequestIdSchema))
    id: string,
    @Query(empty) _query: Record<string, never>,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.assistance.result(bearerToken(auth), id);
  }
  @Post(':requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingAssistanceCancel',
    description:
      'Fence the original key, including a request not yet received. Provider accounting is independent.',
  })
  @ApiOkResponse({
    standardSchema: C.assistanceMetadataSchema,
    headers: ratingResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(C.assistanceRequestIdSchema))
    id: string,
    @Query(empty) _query: Record<string, never>,
    @Body(options(C.assistanceCancelSchema))
    input: z.infer<typeof C.assistanceCancelSchema>,
  ) {
    return this.assistance.cancel(bearerToken(auth), id, input);
  }
}
