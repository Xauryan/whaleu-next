import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { applicationErrorCondition } from '../../http/application-error.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import {
  safeErrorResponseSchema,
  safeHttpErrorDescription,
} from '../../http/error-contracts.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { ViewRequestLimit } from '../../request-throttling/view-request.guard.js';
import {
  viewEpochRequestSchema,
  viewReportSchema,
  viewReportingEpochSchema,
  viewReportReceiptSchema,
} from './contracts.js';
import type { ViewReport } from './contracts.js';
import { ViewReportingService } from './service.js';

const responseHeaders: NonNullable<ApiResponseOptions['headers']> = {
  'x-request-id': {
    description: 'Server-generated request correlation ID.',
    schema: { type: 'string' },
  },
  'cache-control': { schema: { type: 'string', enum: ['no-store'] } },
};

function businessErrorResponse(
  codes: readonly ApplicationErrorCode[],
  detail = '',
): ApiResponseOptions {
  const status = applicationErrorCondition(codes[0]!).status;
  return {
    status,
    description: [
      ...codes.map(
        (code) => `${code}: ${applicationErrorCondition(code).message}.`,
      ),
      detail,
    ]
      .filter(Boolean)
      .join(' '),
    standardSchema: safeErrorResponseSchema,
    headers:
      status === 429
        ? {
            ...responseHeaders,
            'retry-after': { schema: { type: 'string', enum: ['60'] } },
          }
        : responseHeaders,
  };
}

function transportErrorResponse(
  status: number,
  detail = '',
): ApiResponseOptions {
  const { code, message } = safeHttpErrorDescription(status);
  return {
    status,
    description: `${code}: ${message}.${detail ? ` ${detail}` : ''}`,
    standardSchema: safeErrorResponseSchema,
    headers: responseHeaders,
  };
}

@ApiTags('View reporting')
@ApiBearerAuth('accessToken')
@ApiResponse(
  transportErrorResponse(400, 'Malformed or schema-invalid request.'),
)
@ApiResponse(
  businessErrorResponse([
    'AUTHENTICATION_REQUIRED',
    'ACCESS_TOKEN_EXPIRED',
    'SESSION_REVOKED',
  ]),
)
@ApiResponse(businessErrorResponse(['ACCOUNT_BLOCKED']))
@ApiResponse(businessErrorResponse(['VIEW_REPORTING_EPOCH_CLOSED']))
@ApiResponse(
  transportErrorResponse(413, 'Request body exceeds the parser limit.'),
)
@ApiResponse(
  transportErrorResponse(415, 'Unsupported parser charset or encoding.'),
)
@ApiResponse(
  businessErrorResponse(
    ['RATE_LIMITED'],
    'Per-account request-attempt budgets and business epoch/receipt/event quotas can cause this response. The 60-second retry hint does not guarantee a business quota has cleared.',
  ),
)
@ApiResponse(businessErrorResponse(['VIEW_REPORTING_UNAVAILABLE']))
@ApiResponse(transportErrorResponse(500, 'Unexpected failure is sanitized.'))
@Controller('v1/me/community')
export class ViewReportingController {
  constructor(
    @Inject(ViewReportingService) private readonly views: ViewReportingService,
  ) {}
  @Post('view-reporting-epoch')
  @HttpCode(200)
  @ApiOperation({ operationId: 'issueCommunityViewEpoch' })
  @ApiOkResponse({
    description:
      'Issue or reuse an owned collection epoch without extending its immutable lifetime.',
    standardSchema: viewReportingEpochSchema,
    headers: responseHeaders,
  })
  @ViewRequestLimit('epoch')
  epoch(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: viewEpochRequestSchema,
      pipes: [new SchemaValidationPipe(viewEpochRequestSchema)],
    })
    _body: { version: 1 },
  ) {
    return this.views.issueEpoch(bearerToken(auth));
  }
  @Post('view-reports')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'reportCommunityViews',
    description:
      'Reordered normalized multisets replay the original acknowledgement while the owned epoch is live; changing kind or multiplicity conflicts. Missing, denied, or view-unknown targets may be omitted; unavailable policy or infrastructure fails the whole batch. Epoch closure does not prove an uncertain batch was uncounted: do not move uncertain work to a new identity.',
  })
  @ApiOkResponse({
    description:
      'Atomically recorded aggregate receipt, or its immutable replay even if visibility has changed.',
    standardSchema: viewReportReceiptSchema,
    headers: responseHeaders,
  })
  @ApiResponse(businessErrorResponse(['VIEW_REPORT_CONFLICT']))
  @ViewRequestLimit('report')
  report(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: viewReportSchema,
      pipes: [new SchemaValidationPipe(viewReportSchema)],
    })
    body: ViewReport,
  ) {
    return this.views.report(bearerToken(auth), body);
  }
}
