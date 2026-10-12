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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SchemaValidationPipe } from '../../http/validation.js';
import { ApplicationError } from '../../http/application-error.js';
import { bearerToken } from '../../identity/tokens.js';
import { CategoryReclassificationService } from './service.js';
import {
  reclassificationCommandSchema,
  reclassificationEmptyBodySchema,
  reclassificationReceiptSchema,
  reclassificationRecoverySchema,
  categoryManagementSchema,
  categoryRequestIdSchema,
  categoryPostIdSchema,
  categoryEmptyQuerySchema,
} from './contracts.js';
import type { ReclassificationCommand } from './contracts.js';
@ApiTags('Scoped category reclassification')
@ApiBearerAuth('accessToken')
@Controller('v1/community')
export class CategoryReclassificationController {
  constructor(
    @Inject(CategoryReclassificationService)
    private readonly categories: CategoryReclassificationService,
  ) {}
  @Get('posts/:postId/category-management')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'postCategoryManagement' })
  @ApiOkResponse({ standardSchema: categoryManagementSchema })
  management(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(categoryPostIdSchema))
    postId: string,
    @Query(new SchemaValidationPipe(categoryEmptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(reclassificationEmptyBodySchema))
    _body: unknown,
  ) {
    return this.categories.management(bearerToken(auth), postId);
  }
  @Post('category-commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'postCategoryCommand' })
  @ApiOkResponse({ standardSchema: reclassificationReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: reclassificationCommandSchema,
      pipes: [new SchemaValidationPipe(reclassificationCommandSchema)],
    })
    command: ReclassificationCommand,
    @Query(new SchemaValidationPipe(categoryEmptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.categories.command(bearerToken(auth), command);
  }
  @Get('category-requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'postCategoryRecovery' })
  @ApiOkResponse({ standardSchema: reclassificationRecoverySchema })
  recovery(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(categoryRequestIdSchema))
    requestId: string,
    @Query(new SchemaValidationPipe(categoryEmptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(reclassificationEmptyBodySchema))
    _body: unknown,
  ) {
    return this.categories.recovery(bearerToken(auth), requestId);
  }
  @Post('category-requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'postCategoryCancel' })
  @ApiOkResponse({ standardSchema: reclassificationReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(categoryRequestIdSchema))
    requestId: string,
    @Body({
      schema: reclassificationCommandSchema,
      pipes: [new SchemaValidationPipe(reclassificationCommandSchema)],
    })
    command: ReclassificationCommand,
    @Query(new SchemaValidationPipe(categoryEmptyQuerySchema))
    _query: Record<string, never>,
  ) {
    if (requestId !== command.clientRequestId)
      throw new ApplicationError('REQUEST_CONFLICT');
    return this.categories.command(bearerToken(auth), command, true);
  }
}
