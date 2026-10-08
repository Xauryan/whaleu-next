import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { ViewRequestLimit } from '../../request-throttling/view-request.guard.js';
import { viewEpochRequestSchema, viewReportSchema } from './contracts.js';
import type { ViewReport } from './contracts.js';
import { ViewReportingService } from './service.js';
@Controller('v1/me/community')
export class ViewReportingController {
  constructor(
    @Inject(ViewReportingService) private readonly views: ViewReportingService,
  ) {}
  @Post('view-reporting-epoch')
  @HttpCode(200)
  @ViewRequestLimit('epoch')
  epoch(
    @Headers('authorization') auth: unknown,
    @Body(new SchemaValidationPipe(viewEpochRequestSchema))
    _body: { version: 1 },
  ) {
    return this.views.issueEpoch(bearerToken(auth));
  }
  @Post('view-reports')
  @HttpCode(200)
  @ViewRequestLimit('report')
  report(
    @Headers('authorization') auth: unknown,
    @Body(new SchemaValidationPipe(viewReportSchema)) body: ViewReport,
  ) {
    return this.views.report(bearerToken(auth), body);
  }
}
