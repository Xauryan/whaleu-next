import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { safeErrorResponseSchema } from '../http/error-contracts.js';
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
} from '@nestjs/common';
import { z } from 'zod';
import { SchemaValidationPipe } from '../http/validation.js';
import { bearerToken } from '../identity/tokens.js';
import { PHONE_CONSENT, PhoneBindingService } from './phone-binding.service.js';
import { phoneCodeSchema } from './wechat-phone-provider.js';
const reserveSchema = z.strictObject({
  requestId: z.uuid(),
  consent: z.literal(PHONE_CONSENT),
  replacesRequestId: z.uuid().nullable(),
});
const authorizeSchema = z.strictObject({
  code: phoneCodeSchema,
  consent: z.literal(PHONE_CONSENT),
});
const empty = z.strictObject({});
const phoneReceiptSchema = z.strictObject({
  requestId: z.uuid(),
  state: z.enum([
    'reserved',
    'processing',
    'unknown',
    'verified',
    'closed',
    'expired',
    'not_found',
  ]),
});
@ApiTags('Non-production phone authorization')
@ApiBearerAuth('accessToken')
@ApiResponse({
  status: 400,
  standardSchema: safeErrorResponseSchema,
  description: 'Malformed request or explicit consent missing.',
})
@ApiResponse({
  status: 401,
  standardSchema: safeErrorResponseSchema,
  description: 'Current owner authentication required.',
})
@ApiResponse({
  status: 409,
  standardSchema: safeErrorResponseSchema,
  description: 'Original request conflicts with durable recovery state.',
})
@ApiResponse({
  status: 503,
  standardSchema: safeErrorResponseSchema,
  description:
    'Explicit non-production phone binding disabled, unconfigured or provider unavailable.',
})
@Controller('v1/me/phone-binding/requests')
export class PhoneBindingController {
  constructor(
    @Inject(PhoneBindingService) private readonly service: PhoneBindingService,
  ) {}
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post()
  @HttpCode(200)
  @ApiOperation({
    operationId: 'phoneBindingReserve',
    description:
      'Status-only owned recovery; phone values, provider code and tokens are never returned.',
  })
  @ApiOkResponse({
    standardSchema: phoneReceiptSchema,
    headers: {
      'cache-control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  reserve(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: reserveSchema,
      pipes: [new SchemaValidationPipe(reserveSchema)],
    })
    body: z.infer<typeof reserveSchema>,
  ) {
    return this.service.reserve(
      bearerToken(auth),
      body.requestId,
      body.replacesRequestId,
    );
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get(':requestId')
  @ApiOperation({
    operationId: 'phoneBindingRead',
    description:
      'Status-only owned recovery; phone values, provider code and tokens are never returned.',
  })
  @ApiOkResponse({
    standardSchema: phoneReceiptSchema,
    headers: {
      'cache-control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  read(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(z.uuid())) id: string,
  ) {
    return this.service.read(bearerToken(auth), id);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post(':requestId/authorize')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'phoneBindingAuthorize',
    description:
      'Status-only owned recovery; phone values, provider code and tokens are never returned.',
  })
  @ApiOkResponse({
    standardSchema: phoneReceiptSchema,
    headers: {
      'cache-control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  authorize(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(z.uuid())) id: string,
    @Body({
      schema: authorizeSchema,
      pipes: [new SchemaValidationPipe(authorizeSchema)],
    })
    body: z.infer<typeof authorizeSchema>,
  ) {
    return this.service.authorize(bearerToken(auth), id, body.code);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post(':requestId/close')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'phoneBindingClose',
    description:
      'Status-only owned recovery; phone values, provider code and tokens are never returned.',
  })
  @ApiOkResponse({
    standardSchema: phoneReceiptSchema,
    headers: {
      'cache-control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  close(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(z.uuid())) id: string,
    @Body({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _body: z.infer<typeof empty>,
  ) {
    return this.service.close(bearerToken(auth), id);
  }
}
