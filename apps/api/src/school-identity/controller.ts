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
import { SchemaValidationPipe } from '../http/validation.js';
import { bearerToken } from '../identity/tokens.js';
import { SchoolIdentityService } from './service.js';
import {
  schoolIdentityCommandSchema,
  schoolIdentityReceiptSchema,
  schoolIdentityManagementSchema,
  schoolIdentityRecoverySchema,
  schoolIdentityManagementQuerySchema,
  schoolIdentityRequestIdSchema,
  schoolIdentityEmptyBodySchema,
  schoolIdentityEmptyQuerySchema,
} from './contracts.js';
import type { SchoolIdentityCommand } from './contracts.js';
@ApiTags('School identity management')
@ApiBearerAuth('accessToken')
@Controller('v1/admin/school-identities')
export class SchoolIdentityController {
  constructor(
    @Inject(SchoolIdentityService)
    private readonly managementService: SchoolIdentityService,
  ) {}
  @Get('management')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'schoolIdentity' })
  @ApiOkResponse({ standardSchema: schoolIdentityManagementSchema })
  management(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: schoolIdentityManagementQuerySchema,
      pipes: [new SchemaValidationPipe(schoolIdentityManagementQuerySchema)],
    })
    query: { targetProfileId: string; destinationCampusId?: string },
    @Body(new SchemaValidationPipe(schoolIdentityEmptyBodySchema))
    _body: unknown,
  ) {
    return this.managementService.management(
      bearerToken(auth),
      query.targetProfileId,
      query.destinationCampusId,
    );
  }
  @Post('commands')
  @HttpCode(200)
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'schoolIdentityCommand' })
  @ApiOkResponse({ standardSchema: schoolIdentityReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: schoolIdentityCommandSchema,
      pipes: [new SchemaValidationPipe(schoolIdentityCommandSchema)],
    })
    command: SchoolIdentityCommand,
    @Query({
      schema: schoolIdentityEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolIdentityEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.managementService.command(bearerToken(auth), command);
  }
  @Post('commands/cancel')
  @HttpCode(200)
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'schoolIdentityCancel' })
  @ApiOkResponse({ standardSchema: schoolIdentityReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: schoolIdentityCommandSchema,
      pipes: [new SchemaValidationPipe(schoolIdentityCommandSchema)],
    })
    command: SchoolIdentityCommand,
    @Query({
      schema: schoolIdentityEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolIdentityEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.managementService.command(bearerToken(auth), command, true);
  }
  @Get('requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'schoolIdentityRecovery' })
  @ApiOkResponse({ standardSchema: schoolIdentityRecoverySchema })
  recovery(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: schoolIdentityRequestIdSchema,
      pipes: [new SchemaValidationPipe(schoolIdentityRequestIdSchema)],
    })
    requestId: string,
    @Query({
      schema: schoolIdentityEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolIdentityEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(schoolIdentityEmptyBodySchema))
    _body: unknown,
  ) {
    return this.managementService.recovery(bearerToken(auth), requestId);
  }
}

import {
  schoolUidLookupQuerySchema,
  schoolUidLookupSchema,
} from '../school-uid/contracts.js';
@ApiTags('School UID')
@ApiBearerAuth('accessToken')
@Controller('v1/admin/school-uids')
export class SchoolUidLookupController {
  constructor(
    @Inject(SchoolIdentityService)
    private readonly service: SchoolIdentityService,
  ) {}
  @Get('lookup')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'schoolUidLookup' })
  @ApiOkResponse({ standardSchema: schoolUidLookupSchema })
  lookup(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: schoolUidLookupQuerySchema,
      pipes: [new SchemaValidationPipe(schoolUidLookupQuerySchema)],
    })
    query: { schoolCode: string; uid: string },
    @Body(new SchemaValidationPipe(schoolIdentityEmptyBodySchema))
    _body: unknown,
  ) {
    return this.service.lookup(bearerToken(auth), query.schoolCode, query.uid);
  }
}
