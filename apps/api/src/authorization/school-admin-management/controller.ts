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
import { bearerToken } from '../../identity/tokens.js';
import { SchoolAdminManagementService } from './service.js';
import {
  schoolAdminManagementCommandSchema,
  schoolAdminManagementReceiptSchema,
  schoolAdminManagementSchema,
  schoolAdminManagementRecoverySchema,
  schoolAdminManagementQuerySchema,
  schoolAdminManagementRequestIdSchema,
  schoolAdminManagementEmptyBodySchema,
  schoolAdminManagementEmptyQuerySchema,
} from './contracts.js';
import type { SchoolAdminManagementCommand } from './contracts.js';
@ApiTags('School administrator management')
@ApiBearerAuth('accessToken')
@Controller('v1/admin/school-administrators')
export class SchoolAdminManagementController {
  constructor(
    @Inject(SchoolAdminManagementService)
    private readonly managementService: SchoolAdminManagementService,
  ) {}
  @Get('management')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'schoolAdminManagement' })
  @ApiOkResponse({ standardSchema: schoolAdminManagementSchema })
  management(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: schoolAdminManagementQuerySchema,
      pipes: [new SchemaValidationPipe(schoolAdminManagementQuerySchema)],
    })
    query: { targetProfileId: string },
    @Body(new SchemaValidationPipe(schoolAdminManagementEmptyBodySchema))
    _body: unknown,
  ) {
    return this.managementService.management(
      bearerToken(auth),
      query.targetProfileId,
    );
  }
  @Post('commands')
  @HttpCode(200)
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'schoolAdminManagementCommand' })
  @ApiOkResponse({ standardSchema: schoolAdminManagementReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: schoolAdminManagementCommandSchema,
      pipes: [new SchemaValidationPipe(schoolAdminManagementCommandSchema)],
    })
    command: SchoolAdminManagementCommand,
    @Query({
      schema: schoolAdminManagementEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolAdminManagementEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.managementService.command(bearerToken(auth), command);
  }
  @Post('commands/cancel')
  @HttpCode(200)
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'schoolAdminManagementCancel' })
  @ApiOkResponse({ standardSchema: schoolAdminManagementReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: schoolAdminManagementCommandSchema,
      pipes: [new SchemaValidationPipe(schoolAdminManagementCommandSchema)],
    })
    command: SchoolAdminManagementCommand,
    @Query({
      schema: schoolAdminManagementEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolAdminManagementEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.managementService.command(bearerToken(auth), command, true);
  }
  @Get('requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'schoolAdminManagementRecovery' })
  @ApiOkResponse({ standardSchema: schoolAdminManagementRecoverySchema })
  recovery(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: schoolAdminManagementRequestIdSchema,
      pipes: [new SchemaValidationPipe(schoolAdminManagementRequestIdSchema)],
    })
    requestId: string,
    @Query({
      schema: schoolAdminManagementEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolAdminManagementEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(schoolAdminManagementEmptyBodySchema))
    _body: unknown,
  ) {
    return this.managementService.recovery(bearerToken(auth), requestId);
  }
}
