import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
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
import { errandResponseHeaders, ErrandResponses } from '../http/errand-http.js';
import { bearerToken } from '../identity/tokens.js';
import { ErrandRequestGuard } from '../request-throttling/errand-request.guard.js';
import { z } from 'zod';
import {
  errandAdminQuerySchema,
  errandAdminPageSchema,
} from './admin-contracts.js';
import type { ErrandAdminQuery } from './admin-contracts.js';
import { ErrandAdminService } from './admin-service.js';

@ApiTags('Errand administration')
@ApiBearerAuth('accessToken')
@ErrandResponses()
@UseGuards(ErrandRequestGuard)
@Controller('v1/admin/errands')
export class ErrandAdminController {
  constructor(
    @Inject(ErrandAdminService) private readonly admin: ErrandAdminService,
  ) {}
  @Get()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listAdminErrands',
    description:
      'Read-only historical orders in an exact management target. School scope is fixed; global authority must select a target. All includes tombstones; lifecycle filters exclude tombstones. Literal public text/current participant name and exact public UUID search only; legacy numeric UID mapping is unavailable and pure numeric keywords have unavailable totals. Bounded scans, opaque five-minute continuation, exact decimal total only with final owner proof. No participant-private fields or administrative actions.',
  })
  @ApiOkResponse({
    standardSchema: errandAdminPageSchema,
    headers: errandResponseHeaders,
    description: 'Public-only authorized historical catalog',
  })
  list(
    @Headers('authorization') authorization: unknown,
    @Query({
      schema: errandAdminQuerySchema,
      pipes: [new SchemaValidationPipe(errandAdminQuerySchema)],
    })
    query: ErrandAdminQuery,
    @Body(new SchemaValidationPipe(z.undefined())) _body: unknown,
  ) {
    return this.admin.list(bearerToken(authorization), query);
  }
}
