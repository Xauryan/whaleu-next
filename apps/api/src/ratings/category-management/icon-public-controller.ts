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
import { bearerToken } from '../../identity/tokens.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import { RatingScopedContextService } from '../scoped/context.service.js';
import { RatingScopedReadService } from '../scoped/read.service.js';
import {
  ratingScopedCategoryQuerySchema,
  ratingScopedContextRequestSchema,
  ratingScopedContextSchema,
  ratingScopedReadQuerySchema,
  scopedId,
} from '../scoped/contracts.js';
import {
  ratingCategoryIconPageSchema,
  ratingCategoryIconPublicContextSchema,
  ratingCategoryWithIconSchema,
} from './icon-public-contracts.js';

const emptyQuery = new SchemaValidationPipe(z.strictObject({}));
const emptyBody = new SchemaValidationPipe(
  z.union([z.undefined(), z.strictObject({})]),
);
const options = (schema: z.ZodType) => ({
  schema,
  pipes: [new SchemaValidationPipe(schema)],
});
export const ratingCategoryIconEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('icon'),
    context: ratingCategoryIconPublicContextSchema,
  }),
  z.strictObject({
    kind: z.literal('legacy'),
    context: ratingScopedContextSchema,
  }),
]);

@ApiTags('Ratings category icons')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v5/ratings')
export class RatingCategoryIconPublicController {
  constructor(
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedReadService)
    private readonly reads: RatingScopedReadService,
  ) {}

  @Post('entry-context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingCategoryIconEntryContext' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingCategoryIconEntrySchema,
  })
  entryContext(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedContextRequestSchema))
    body: z.infer<typeof ratingScopedContextRequestSchema>,
  ) {
    return this.contexts.createCategoryIconEntry(bearerToken(auth), body);
  }

  @Post('contexts')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingCategoryIconPublicContext' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingCategoryIconPublicContextSchema,
  })
  context(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedContextRequestSchema))
    body: z.infer<typeof ratingScopedContextRequestSchema>,
  ) {
    return this.contexts.createCategoryIcon(bearerToken(auth), body);
  }

  @Get('categories')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingCategoryIconPublicCategories' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingCategoryIconPageSchema,
  })
  categories(
    @Headers('authorization') auth: unknown,
    @Query(options(ratingScopedCategoryQuerySchema))
    query: z.infer<typeof ratingScopedCategoryQuerySchema>,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.reads.categories(bearerToken(auth), query, true);
  }

  @Get('categories/:id')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingCategoryIconPublicCategory' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingCategoryWithIconSchema,
  })
  category(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(scopedId)) id: string,
    @Query(options(ratingScopedReadQuerySchema))
    query: z.infer<typeof ratingScopedReadQuerySchema>,
    @Body(emptyBody) _body: unknown,
  ) {
    return this.reads.categoryIcon(bearerToken(auth), id, query);
  }
}
