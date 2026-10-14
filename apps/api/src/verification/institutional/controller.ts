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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';
import { safeErrorResponseSchema } from '../../http/error-contracts.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import {
  institutionalCapabilitySchema,
  institutionalPrepareSchema,
  institutionalCompleteSchema,
  institutionalCloseSchema,
  institutionalReceiptSchema,
} from './contracts.js';
import type {
  InstitutionalPrepare,
  InstitutionalComplete,
} from './contracts.js';
import { InstitutionalSsoService } from './service.js';
const querySchema = z.strictObject({ campusId: z.uuid() });
function json(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value)
  )
    throw new ApplicationError('INSTITUTIONAL_SSO_INVALID');
}
@ApiTags('Institutional verification')
@ApiBearerAuth('accessToken')
@ApiResponse({
  status: 400,
  standardSchema: safeErrorResponseSchema,
  description: 'Strict bounded JSON and explicit consent are required.',
})
@ApiResponse({
  status: 401,
  standardSchema: safeErrorResponseSchema,
  description: 'Current owner authentication is required.',
})
@ApiResponse({
  status: 409,
  standardSchema: safeErrorResponseSchema,
  description: 'The original request identity conflicts.',
})
@ApiResponse({
  status: 503,
  standardSchema: safeErrorResponseSchema,
  description:
    'Institutional verification is unavailable. No real provider is configured by default.',
})
@Controller('v1/me/institutional-sso')
export class InstitutionalSsoController {
  constructor(
    @Inject(InstitutionalSsoService)
    private readonly service: InstitutionalSsoService,
  ) {}
  @Get('capability')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'institutionalSsoCapability',
    description: 'Current safe capability; this read is not authorization.',
  })
  @ApiQuery({
    name: 'campusId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({
    standardSchema: institutionalCapabilitySchema,
    headers: {
      'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
      Vary: { schema: { type: 'string', enum: ['Authorization'] } },
    },
  })
  capability(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(querySchema))
    query: z.infer<typeof querySchema>,
  ) {
    return this.service.capability(bearerToken(auth), query.campusId);
  }
  @Post('requests')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'institutionalSsoPrepare',
    description:
      'Freeze an original actor-owned institutional verification intent.',
  })
  @ApiOkResponse({
    standardSchema: institutionalReceiptSchema,
    headers: {
      'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
      Vary: { schema: { type: 'string', enum: ['Authorization'] } },
    },
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Headers('content-type') type: unknown,
    @Body({
      schema: institutionalPrepareSchema,
      pipes: [new SchemaValidationPipe(institutionalPrepareSchema)],
    })
    body: InstitutionalPrepare,
  ) {
    json(type);
    return this.service.prepare(bearerToken(auth), body);
  }
  @Get('requests/:requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'institutionalSsoRead',
    description:
      'Recover only the current actor’s original request; never repeats provider verification.',
  })
  @ApiOkResponse({
    standardSchema: institutionalReceiptSchema,
    headers: {
      'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
      Vary: { schema: { type: 'string', enum: ['Authorization'] } },
    },
  })
  read(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(z.uuid())) id: string,
  ) {
    return this.service.read(bearerToken(auth), id);
  }
  @Post('requests/:requestId/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'institutionalSsoComplete',
    description:
      'Submit one opaque response once, or locally recover a durable admitted proof without provider replay.',
  })
  @ApiOkResponse({
    standardSchema: institutionalReceiptSchema,
    headers: {
      'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
      Vary: { schema: { type: 'string', enum: ['Authorization'] } },
    },
  })
  async complete(
    @Headers('authorization') auth: unknown,
    @Headers('content-type') type: unknown,
    @Param('requestId', new SchemaValidationPipe(z.uuid())) id: string,
    @Body({
      schema: institutionalCompleteSchema,
      pipes: [new SchemaValidationPipe(institutionalCompleteSchema)],
    })
    body: InstitutionalComplete,
  ) {
    json(type);
    try {
      return await this.service.complete(bearerToken(auth), id, body);
    } finally {
      if (body.mode === 'authorize') body.authorizationResponse = '';
    }
  }
  @Post('requests/:requestId/close')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'institutionalSsoClose',
    description:
      'Cancel the exact original operation, including an absent-key fence. Completion that committed first remains historical success.',
  })
  @ApiOkResponse({
    standardSchema: institutionalReceiptSchema,
    headers: {
      'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
      Vary: { schema: { type: 'string', enum: ['Authorization'] } },
    },
  })
  close(
    @Headers('authorization') auth: unknown,
    @Headers('content-type') type: unknown,
    @Param('requestId', new SchemaValidationPipe(z.uuid())) id: string,
    @Body({
      schema: institutionalCloseSchema,
      pipes: [new SchemaValidationPipe(institutionalCloseSchema)],
    })
    body: z.infer<typeof institutionalCloseSchema>,
  ) {
    json(type);
    return this.service.close(bearerToken(auth), id, body.requestHash);
  }
}
