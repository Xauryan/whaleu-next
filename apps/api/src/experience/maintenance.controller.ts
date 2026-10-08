import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { experienceEmptySchema, experienceIdSchema } from './contracts.js';
import { maintenanceSchema } from './maintenance.contracts.js';
import type { MaintenanceIntent } from './maintenance.contracts.js';
import { ExperienceTitleMaintenanceService } from './maintenance.service.js';

@Controller('v1/admin/experience/title-maintenance')
export class ExperienceTitleMaintenanceController {
  constructor(
    @Inject(ExperienceTitleMaintenanceService)
    private readonly service: ExperienceTitleMaintenanceService,
  ) {}

  @Post('batches') @HttpCode(200) batch(
    @Headers('authorization') auth: unknown,
    @Body(new SchemaValidationPipe(maintenanceSchema)) body: MaintenanceIntent,
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.batch(bearerToken(auth), body);
  }

  @Get('requests/:requestId') receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(experienceIdSchema))
    requestId: string,
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.receipt(bearerToken(auth), requestId);
  }
}
