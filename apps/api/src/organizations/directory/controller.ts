import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { DirectoryRequestGuard } from '../../request-throttling/directory-request.guard.js';
import { safeErrorResponseSchema } from '../../http/error-contracts.js';
import { DirectoryService } from './service.js';
import {
  directoryIdSchema,
  directoryCategoryQuerySchema,
  directoryEntryQuerySchema,
  directoryEmptyQuerySchema,
  directoryEmptyBodySchema,
  directoryContextSchema,
  directoryCategoryPageSchema,
  directoryEntryPageSchema,
  directoryDetailSchema,
} from './contracts.js';
import type {
  DirectoryCategoryQuery,
  DirectoryEntryQuery,
} from './contracts.js';
const headers = {
  'cache-control': { schema: { type: 'string' as const, enum: ['no-store'] } },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
@ApiTags('Organization directory')
@ApiBearerAuth('accessToken')
@ApiResponse({
  status: 400,
  description: 'Strict request validation failed.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 401,
  description: 'Required current session is absent, expired or revoked.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 403,
  description:
    'Current phone, affiliation, identity-home scope or Safety permission is required. Administrative roles do not bypass these gates.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 404,
  description:
    'DIRECTORY_NOT_FOUND: target is unavailable. Missing, unapproved and out-of-scope entries share this result.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 409,
  description:
    'DISCOVERY_RESTART_REQUIRED: navigation binding, accepted catalog revision or cursor lifetime changed. Reload only after user choice.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 429,
  description: 'RATE_LIMITED: account directory read-attempt budget exceeded.',
  standardSchema: safeErrorResponseSchema,
  headers: {
    ...headers,
    'retry-after': { schema: { type: 'string', enum: ['60'] } },
  },
})
@ApiResponse({
  status: 503,
  description:
    'Current verification, Safety, campus, taxonomy or catalog evidence is unavailable. Missing catalog is never known empty.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 500,
  description: 'Unexpected failure is sanitized.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@UseGuards(DirectoryRequestGuard)
@Controller('v1/directory')
export class DirectoryController {
  constructor(
    @Inject(DirectoryService) private readonly directory: DirectoryService,
  ) {}
  @Get('context')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readDirectoryContext',
    description:
      'Resolve canonical current identity-home region under all member gates. Does not select or change identity campus.',
  })
  @ApiOkResponse({
    standardSchema: directoryContextSchema,
    headers,
    description: 'Current authorized home-region context.',
  })
  context(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: directoryEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(directoryEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(directoryEmptyBodySchema)) _body: unknown,
  ) {
    return this.directory.context(bearerToken(auth));
  }
  @Get('regions/:regionId/categories')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listDirectoryCategories',
    description:
      'Read bounded current accepted taxonomy in accepted source order. Official taxonomy is global; member access remains home-region scoped.',
  })
  @ApiOkResponse({
    standardSchema: directoryCategoryPageSchema,
    headers,
    description:
      'Current categories, including known-empty when complete source evidence establishes it.',
  })
  categories(
    @Headers('authorization') auth: unknown,
    @Param('regionId', {
      schema: directoryIdSchema,
      pipes: [new SchemaValidationPipe(directoryIdSchema)],
    })
    regionId: string,
    @Query({
      schema: directoryCategoryQuerySchema,
      pipes: [new SchemaValidationPipe(directoryCategoryQuerySchema)],
    })
    query: DirectoryCategoryQuery,
    @Body(new SchemaValidationPipe(directoryEmptyBodySchema)) _body: unknown,
  ) {
    return this.directory.categories(bearerToken(auth), regionId, query);
  }
  @Get('regions/:regionId/entries')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listDirectoryEntries',
    description:
      'Category is required unless q is present. q is trimmed, 1–100 Unicode code points/400 UTF-8 bytes, without control characters or unpaired surrogates. Literal ASCII case-insensitive name-only substring matching uses explicit ASCII folding and C collation. Chinese and other non-ASCII code points remain literal; no accent, pinyin or Unicode normalization. %, _ and backslash are literal. Accepted snapshot ordering; no totals, contacts, private actors or raw media.',
  })
  @ApiOkResponse({
    standardSchema: directoryEntryPageSchema,
    headers,
    description: 'Bounded approved entry summaries in server order.',
  })
  entries(
    @Headers('authorization') auth: unknown,
    @Param('regionId', {
      schema: directoryIdSchema,
      pipes: [new SchemaValidationPipe(directoryIdSchema)],
    })
    regionId: string,
    @Query({
      schema: directoryEntryQuerySchema,
      pipes: [new SchemaValidationPipe(directoryEntryQuerySchema)],
    })
    query: DirectoryEntryQuery,
    @Body(new SchemaValidationPipe(directoryEmptyBodySchema)) _body: unknown,
  ) {
    return this.directory.entries(bearerToken(auth), regionId, query);
  }
  @Get('regions/:regionId/entries/:entryId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readDirectoryEntry',
    description:
      'Platform-discriminated approved detail. QQ contact appears only here. Media delivery, managers, management and live visit counts remain explicitly unavailable. GET never records a visit.',
  })
  @ApiOkResponse({
    standardSchema: directoryDetailSchema,
    headers,
    description: 'Current approved member detail.',
  })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('regionId', {
      schema: directoryIdSchema,
      pipes: [new SchemaValidationPipe(directoryIdSchema)],
    })
    regionId: string,
    @Param('entryId', {
      schema: directoryIdSchema,
      pipes: [new SchemaValidationPipe(directoryIdSchema)],
    })
    entryId: string,
    @Query({
      schema: directoryEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(directoryEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(directoryEmptyBodySchema)) _body: unknown,
  ) {
    return this.directory.detail(bearerToken(auth), regionId, entryId);
  }
}
