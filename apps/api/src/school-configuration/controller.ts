import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Post,
  HttpCode,
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
import { bearerToken } from '../identity/tokens.js';
import { SchoolConfigurationService } from './service.js';
import { SchoolConfigurationRequestGuard } from './request-guard.js';
import {
  schoolIdSchema,
  schoolEntryKeySchema,
  schoolBrowseQuerySchema,
  schoolManagementQuerySchema,
  schoolEmptyQuerySchema,
  schoolEmptyBodySchema,
  saveSchoolEntrySchema,
  schoolPublicViewSchema,
  schoolManagementViewSchema,
  schoolCapabilitiesSchema,
  schoolSaveReceiptSchema,
  schoolRecoverySchema,
  schoolCancelCommandSchema,
} from './contracts.js';
import type { SchoolEntryKey, SaveSchoolEntry } from './contracts.js';
import { z } from 'zod';
@ApiTags('School configuration')
@UseGuards(SchoolConfigurationRequestGuard)
@Controller('v1/school-services')
export class SchoolServicesController {
  constructor(
    @Inject(SchoolConfigurationService)
    private readonly service: SchoolConfigurationService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readSchoolServices',
    security: [{}, { accessToken: [] }],
    description:
      'Guest-capable exact physical-campus mapping to three public groups, official account and admin contact. Review group and disabled entry data are never public. Missing configuration is unconfigured, not accepted legacy coverage.',
  })
  @ApiOkResponse({ standardSchema: schoolPublicViewSchema })
  read(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: schoolBrowseQuerySchema,
      pipes: [new SchemaValidationPipe(schoolBrowseQuerySchema)],
    })
    query: { campusId: string },
    @Body(new SchemaValidationPipe(schoolEmptyBodySchema))
    _body: unknown,
  ) {
    return this.service.public(
      auth === undefined ? null : bearerToken(auth),
      query.campusId,
    );
  }
}
@ApiTags('School configuration')
@ApiBearerAuth('accessToken')
@UseGuards(SchoolConfigurationRequestGuard)
@Controller('v1/me/school-configuration')
export class SchoolConfigurationController {
  constructor(
    @Inject(SchoolConfigurationService)
    private readonly service: SchoolConfigurationService,
  ) {}
  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readSchoolConfigurationCapabilities',
    description:
      'Advisory true-grant school management. Developer grants and selected campus do not grant authority.',
  })
  @ApiOkResponse({ standardSchema: schoolCapabilitiesSchema })
  capabilities(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: schoolEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolEmptyQuerySchema)],
    })
    _query: unknown,
    @Body(new SchemaValidationPipe(schoolEmptyBodySchema))
    _body: unknown,
  ) {
    return this.service.capabilities(bearerToken(auth));
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readSchoolConfiguration',
    description:
      'School administrator fixed grant region, super administrator explicit active target. Includes internal review group; never secrets or push-provider parameters.',
  })
  @ApiOkResponse({ standardSchema: schoolManagementViewSchema })
  read(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: schoolManagementQuerySchema,
      pipes: [new SchemaValidationPipe(schoolManagementQuerySchema)],
    })
    query: { regionId?: string },
    @Body(new SchemaValidationPipe(schoolEmptyBodySchema))
    _body: unknown,
  ) {
    return this.service.management(bearerToken(auth), query.regionId);
  }
  @Post(':regionId/entries/:entryKey')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'saveSchoolConfigurationEntry',
    description:
      'One exact entry CAS publication. Actor/request key and complete canonical command hash are stable; exact replay returns original receipt. QR replacement accepts only the school Media owner asset; trusted text publication never grants image approval.',
  })
  @ApiOkResponse({ standardSchema: schoolSaveReceiptSchema })
  save(
    @Headers('authorization') auth: unknown,
    @Param('regionId', {
      schema: schoolIdSchema,
      pipes: [new SchemaValidationPipe(schoolIdSchema)],
    })
    regionId: string,
    @Param('entryKey', {
      schema: schoolEntryKeySchema,
      pipes: [new SchemaValidationPipe(schoolEntryKeySchema)],
    })
    entryKey: SchoolEntryKey,
    @Query({
      schema: schoolEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolEmptyQuerySchema)],
    })
    _query: unknown,
    @Body({
      schema: saveSchoolEntrySchema,
      pipes: [new SchemaValidationPipe(saveSchoolEntrySchema)],
    })
    command: SaveSchoolEntry,
  ) {
    return this.service.save(bearerToken(auth), regionId, entryKey, command);
  }
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'cancelSchoolConfigurationRequest',
    description:
      'Owner exact-hash cancellation fence. Serialized with publication; never reverses a saved command.',
  })
  @ApiOkResponse({ standardSchema: schoolRecoverySchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(z.uuidv4())) requestId: string,
    @Query({
      schema: schoolEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolEmptyQuerySchema)],
    })
    _query: unknown,
    @Body({
      schema: schoolCancelCommandSchema,
      pipes: [new SchemaValidationPipe(schoolCancelCommandSchema)],
    })
    command: { requestHash: string },
  ) {
    return this.service.cancel(
      bearerToken(auth),
      requestId,
      command.requestHash,
    );
  }
  @Get('requests/:requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'recoverSchoolConfigurationRequest',
    description:
      'Owner-only historical metadata, never configuration content or current management/media authority.',
  })
  @ApiOkResponse({ standardSchema: schoolRecoverySchema })
  recover(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(z.uuidv4())) requestId: string,
    @Query({
      schema: schoolEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolEmptyQuerySchema)],
    })
    _query: unknown,
    @Body(new SchemaValidationPipe(schoolEmptyBodySchema))
    _body: unknown,
  ) {
    return this.service.recover(bearerToken(auth), requestId);
  }
}
