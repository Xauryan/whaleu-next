import {
  Body,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { idSchema, requestIdSchema } from '../../community/contracts.js';
import { emptyQuerySchema } from '../contracts.js';
import { reportRequestSchema, juryVoteSchema } from './contracts.js';
import type {
  ReportRequest,
  JuryVoteRequest,
  ReportTarget,
} from './contracts.js';
import { ReportingService } from './service.js';
@Controller('v1/me/safety')
export class ReportingController {
  constructor(
    @Inject(ReportingService) private readonly reports: ReportingService,
  ) {}
  @Post('reports')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  report(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(reportRequestSchema)) body: ReportRequest,
  ) {
    return this.reports.report(bearerToken(auth), body);
  }
  @Post('jury-votes')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  vote(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(juryVoteSchema)) body: JuryVoteRequest,
  ) {
    return this.reports.vote(bearerToken(auth), body);
  }
  @Get('report-progress/:kind/:id')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  progress(
    @Headers('authorization') auth: unknown,
    @Param(
      'kind',
      new SchemaValidationPipe(z.enum(['post', 'comment', 'reply'])),
    )
    kind: ReportTarget['kind'],
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.reports.progress(bearerToken(auth), { kind, id });
  }
  @Get('report-requests/:id')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(requestIdSchema)) id: string,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.reports.receipt(bearerToken(auth), id);
  }
}
