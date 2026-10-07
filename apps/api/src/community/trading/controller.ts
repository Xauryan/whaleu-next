import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { idSchema, requestIdSchema } from '../contracts.js';
import { setTradingResolutionSchema } from './contracts.js';
import type { SetTradingResolution } from './contracts.js';
import { TradingService } from './service.js';
@Controller('v1/community/posts')
export class TradingController {
  constructor(
    @Inject(TradingService) private readonly trading: TradingService,
  ) {}
  @Get(':postId/trading/contacts') contacts(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.trading.contacts(bearerToken(auth), id);
  }
  @Post(':postId/trading/resolution') resolve(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(setTradingResolutionSchema))
    body: SetTradingResolution,
  ) {
    return this.trading.setResolution(bearerToken(auth), id, body);
  }
}
@Controller('v1/me/community')
export class TradingRecoveryController {
  constructor(
    @Inject(TradingService) private readonly trading: TradingService,
  ) {}
  @Get('trading-requests/:requestId') receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(requestIdSchema)) id: string,
  ) {
    return this.trading.receipt(bearerToken(auth), id);
  }
}
