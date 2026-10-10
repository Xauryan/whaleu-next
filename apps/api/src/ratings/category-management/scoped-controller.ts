import {
  applyDecorators,
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
import { scopedId } from '../scoped/contracts.js';
import { RatingCategoryScopedManagementService } from './scoped-service.js';
import * as contracts from './scoped-contracts.js';

const options = <T>(schema: z.ZodType<T>) => ({
  schema,
  pipes: [new SchemaValidationPipe(schema)],
});
const emptyQuery = options(ratingEmptySchema);
const emptyBody = z.union([z.undefined(), ratingEmptySchema]);
function route(
  method: 'GET' | 'POST',
  path: string,
  name: string,
  response: z.ZodType,
) {
  return applyDecorators(
    (method === 'GET' ? Get : Post)(path),
    HttpCode(200),
    Header('Cache-Control', 'no-store'),
    Header('Vary', 'Authorization'),
    ApiOperation({
      operationId: `ratingScopedCategoryManagement${name}`,
      description:
        'Exact category-only management domain. Current authority, complete sources and Review are independently required; original request recovery never gains publication authority.',
    }),
    ApiOkResponse({ standardSchema: response, headers: ratingResponseHeaders }),
  );
}

/** Thin category-only boundary. Existing public and preview contexts cannot
 * become management authority; all writes use the exact prepare/commit union. */
@ApiTags('Scoped rating category management')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v2/ratings/category-management')
export class RatingCategoryScopedManagementController {
  constructor(
    @Inject(RatingCategoryScopedManagementService)
    private readonly management: RatingCategoryScopedManagementService,
  ) {}

  @route(
    'POST',
    'contexts',
    'Context',
    contracts.ratingCategoryManagementContextSchema,
  )
  context(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryManagementContextRequestSchema))
    input: z.infer<
      typeof contracts.ratingCategoryManagementContextRequestSchema
    >,
  ) {
    return this.management.context(bearerToken(auth), input);
  }

  @route('GET', 'categories', 'List', contracts.ratingManagedCategoriesSchema)
  list(
    @Headers('authorization') auth: unknown,
    @Query(options(contracts.ratingCategoryManagementQuerySchema))
    query: z.infer<typeof contracts.ratingCategoryManagementQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.management.list(bearerToken(auth), query);
  }

  @route(
    'GET',
    'categories/:categoryId',
    'Detail',
    contracts.ratingManagedCategorySchema,
  )
  detail(
    @Headers('authorization') auth: unknown,
    @Param('categoryId', new SchemaValidationPipe(scopedId)) categoryId: string,
    @Query(options(contracts.ratingCategoryManagementQuerySchema))
    query: z.infer<typeof contracts.ratingCategoryManagementQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.management.detail(bearerToken(auth), query, categoryId);
  }

  @route(
    'GET',
    'categories/:categoryId/history',
    'History',
    contracts.ratingCategoryManagementHistorySchema,
  )
  history(
    @Headers('authorization') auth: unknown,
    @Param('categoryId', new SchemaValidationPipe(scopedId)) categoryId: string,
    @Query(options(contracts.ratingCategoryManagementHistoryQuerySchema))
    query: z.infer<typeof contracts.ratingCategoryManagementHistoryQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.management.history(bearerToken(auth), query, categoryId);
  }

  @route(
    'GET',
    'system-options',
    'SystemOptions',
    contracts.ratingCategorySystemOptionsSchema,
  )
  systemOptions(
    @Headers('authorization') auth: unknown,
    @Query(options(contracts.ratingCategoryManagementQuerySchema))
    query: z.infer<typeof contracts.ratingCategoryManagementQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.management.systemOptions(bearerToken(auth), query);
  }

  @route(
    'POST',
    'prepare',
    'Prepare',
    contracts.ratingCategoryScopedPrepareResultSchema,
  )
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryScopedIntentSchema))
    intent: contracts.RatingCategoryScopedIntent,
  ) {
    return this.management.prepare(bearerToken(auth), intent);
  }

  @route(
    'POST',
    'commit',
    'Commit',
    contracts.ratingCategoryScopedReceiptSchema,
  )
  commit(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryScopedCommitSchema))
    input: z.infer<typeof contracts.ratingCategoryScopedCommitSchema>,
  ) {
    return this.management.commit(bearerToken(auth), input);
  }

  @route(
    'POST',
    'cancel',
    'Cancel',
    contracts.ratingCategoryScopedReceiptSchema,
  )
  cancel(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryScopedIntentSchema))
    intent: contracts.RatingCategoryScopedIntent,
  ) {
    return this.management.cancel(bearerToken(auth), intent);
  }
}
