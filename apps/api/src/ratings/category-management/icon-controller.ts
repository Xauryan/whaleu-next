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
import { categoryIconMediaRecoverySchema } from '../../media/contracts-category-icon.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import { ratingEmptySchema } from '../contracts.js';
import { scopedId } from '../scoped/contracts.js';
import { RatingCategoryIconManagementService } from './icon-service.js';
import * as contracts from './icon-contracts.js';
import * as scoped from './scoped-contracts.js';

const options = <T>(schema: z.ZodType<T>) => ({
  schema,
  pipes: [new SchemaValidationPipe(schema)],
});
const emptyQuery = options(ratingEmptySchema);
const emptyBody = z.union([z.undefined(), ratingEmptySchema]);

export const ratingCategoryIconManagementEntrySchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('icon'),
      context: contracts.ratingCategoryIconContextSchema,
    }),
    z.strictObject({
      kind: z.literal('legacy'),
      context: scoped.ratingCategoryManagementContextSchema,
    }),
  ],
);
export const ratingCategoryIconUploadScopeRecoveryResultSchema = z
  .strictObject({
    scope: contracts.ratingCategoryIconUploadScopeResultSchema.nullable(),
    recovery: categoryIconMediaRecoverySchema.nullable(),
    state: z.enum(['known', 'unknown', 'cancelled']),
  })
  .refine(
    ({ scope, recovery, state }) =>
      (state !== 'known' || scope !== null) &&
      (state !== 'unknown' || (scope === null && recovery === null)) &&
      (scope === null ||
        recovery?.state !== 'recorded' ||
        recovery.status.editScopeId === scope.editScopeId),
  );

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
      operationId: `ratingCategoryIconManagement${name}`,
      description:
        'Exact protocol5 category icon management. Current authority, complete sources and Review are independently required; original request and upload recovery never gain publication authority.',
    }),
    ApiOkResponse({ standardSchema: response, headers: ratingResponseHeaders }),
  );
}

/** Protocol5 is independently dispatched; legacy codecs never accept icons. */
@ApiTags('Rating category icon management')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v5/ratings/category-management')
export class RatingCategoryIconManagementController {
  constructor(
    @Inject(RatingCategoryIconManagementService)
    private readonly management: RatingCategoryIconManagementService,
  ) {}

  @route(
    'POST',
    'retirement/status',
    'RetirementStatus',
    contracts.categoryIconRetirementStatusSchema,
  )
  retirementStatus(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.categoryIconRetirementStatusRequestSchema))
    input: z.infer<typeof contracts.categoryIconRetirementStatusRequestSchema>,
  ) {
    return this.management.retirementStatus(bearerToken(auth), input);
  }
  @route(
    'POST',
    'retirement/cleanup',
    'RetirementCleanup',
    contracts.categoryIconRetirementCleanupSchema,
  )
  retirementCleanup(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.categoryIconRetirementRequestSchema))
    input: z.infer<typeof contracts.categoryIconRetirementRequestSchema>,
  ) {
    return this.management.cleanupRetirement(bearerToken(auth), input);
  }
  @route(
    'POST',
    'entry-context',
    'EntryContext',
    ratingCategoryIconManagementEntrySchema,
  )
  entryContext(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(scoped.ratingCategoryManagementContextRequestSchema))
    input: z.infer<typeof scoped.ratingCategoryManagementContextRequestSchema>,
  ) {
    return this.management.entryContext(bearerToken(auth), input);
  }

  @route(
    'POST',
    'contexts',
    'Context',
    contracts.ratingCategoryIconContextSchema,
  )
  context(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(scoped.ratingCategoryManagementContextRequestSchema))
    input: z.infer<typeof scoped.ratingCategoryManagementContextRequestSchema>,
  ) {
    return this.management.context(bearerToken(auth), input);
  }

  @route(
    'GET',
    'categories',
    'List',
    contracts.ratingManagedCategoryIconsSchema,
  )
  list(
    @Headers('authorization') auth: unknown,
    @Query(options(scoped.ratingCategoryManagementQuerySchema))
    query: z.infer<typeof scoped.ratingCategoryManagementQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.management.list(bearerToken(auth), query);
  }

  @route(
    'GET',
    'categories/:categoryId',
    'Detail',
    contracts.ratingManagedCategoryIconSchema,
  )
  detail(
    @Headers('authorization') auth: unknown,
    @Param('categoryId', new SchemaValidationPipe(scopedId)) categoryId: string,
    @Query(options(scoped.ratingCategoryManagementQuerySchema))
    query: z.infer<typeof scoped.ratingCategoryManagementQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.management.detail(bearerToken(auth), query, categoryId);
  }

  @route(
    'GET',
    'categories/:categoryId/history',
    'History',
    scoped.ratingCategoryManagementHistorySchema,
  )
  history(
    @Headers('authorization') auth: unknown,
    @Param('categoryId', new SchemaValidationPipe(scopedId)) categoryId: string,
    @Query(options(scoped.ratingCategoryManagementHistoryQuerySchema))
    query: z.infer<typeof scoped.ratingCategoryManagementHistoryQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.management.history(bearerToken(auth), query, categoryId);
  }

  @route(
    'GET',
    'system-options',
    'SystemOptions',
    scoped.ratingCategorySystemOptionsSchema,
  )
  systemOptions(
    @Headers('authorization') auth: unknown,
    @Query(options(scoped.ratingCategoryManagementQuerySchema))
    query: z.infer<typeof scoped.ratingCategoryManagementQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.management.systemOptions(bearerToken(auth), query);
  }

  @route(
    'POST',
    'upload-scopes',
    'UploadScope',
    contracts.ratingCategoryIconUploadScopeResultSchema,
  )
  uploadScope(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryIconUploadScopeSchema))
    input: contracts.RatingCategoryIconUploadScopeInput,
  ) {
    return this.management.uploadScope(bearerToken(auth), input);
  }

  @route(
    'POST',
    'upload-scopes/recover',
    'RecoverUploadScope',
    ratingCategoryIconUploadScopeRecoveryResultSchema,
  )
  recoverUploadScope(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryIconUploadScopeRecoverySchema))
    input: z.infer<
      typeof contracts.ratingCategoryIconUploadScopeRecoverySchema
    >,
  ) {
    return this.management.recoverUploadScope(bearerToken(auth), input);
  }

  @route(
    'POST',
    'upload-scopes/cancel',
    'CancelUploadScope',
    ratingCategoryIconUploadScopeRecoveryResultSchema,
  )
  cancelUploadScope(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryIconUploadScopeRecoverySchema))
    input: z.infer<
      typeof contracts.ratingCategoryIconUploadScopeRecoverySchema
    >,
  ) {
    return this.management.cancelUploadScope(bearerToken(auth), input);
  }

  @route(
    'POST',
    'prepare',
    'Prepare',
    contracts.ratingCategoryIconPrepareResultSchema,
  )
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryIconIntentSchema))
    intent: contracts.RatingCategoryIconIntent,
  ) {
    return this.management.prepare(bearerToken(auth), intent);
  }

  @route('POST', 'commit', 'Commit', contracts.ratingCategoryIconReceiptSchema)
  commit(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryIconCommitSchema))
    input: z.infer<typeof contracts.ratingCategoryIconCommitSchema>,
  ) {
    return this.management.commit(bearerToken(auth), input);
  }

  @route('POST', 'cancel', 'Cancel', contracts.ratingCategoryIconReceiptSchema)
  cancel(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryIconIntentSchema))
    intent: contracts.RatingCategoryIconIntent,
  ) {
    return this.management.cancel(bearerToken(auth), intent);
  }

  @route(
    'POST',
    'cancel-by-hash',
    'CancelByHash',
    contracts.ratingCategoryIconReceiptSchema,
  )
  cancelByHash(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingCategoryIconRecoveryClosureSchema))
    input: z.infer<typeof contracts.ratingCategoryIconRecoveryClosureSchema>,
  ) {
    return this.management.cancelByHash(bearerToken(auth), input);
  }
}

/** Original-request recovery remains usable without a new management context. */
@ApiTags('Rating category icon management')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v5/ratings/requests')
export class RatingCategoryIconRequestController {
  constructor(
    @Inject(RatingCategoryIconManagementService)
    private readonly management: RatingCategoryIconManagementService,
  ) {}

  @route(
    'GET',
    ':requestId',
    'GetRequest',
    contracts.ratingCategoryIconReceiptSchema,
  )
  request(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(scopedId)) requestId: string,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.management.recover(bearerToken(auth), requestId);
  }
}
