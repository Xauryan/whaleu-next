import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { experienceCatalog } from './catalog.js';
import {
  appearanceSchema,
  experienceEmptySchema,
  experienceIdSchema,
  experiencePageSchema,
  signInSchema,
  redemptionSchema,
} from './contracts.js';
import type { AppearanceIntent, ExperiencePageQuery } from './contracts.js';
import type { RedemptionIntent } from './contracts.js';
import { ExperienceRedemptionService } from './redemption.service.js';
import { ExperienceService } from './service.js';
@Controller('v1/experience')
export class ExperienceCatalogController {
  @Get('catalog') catalog(
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return experienceCatalog();
  }
}
@Controller('v1/me/experience')
export class ExperienceController {
  constructor(
    @Inject(ExperienceService) private readonly service: ExperienceService,
    @Inject(ExperienceRedemptionService)
    private readonly redemption: ExperienceRedemptionService,
  ) {}
  @Get('redemption') capability(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.redemption.capability(bearerToken(auth));
  }
  @Post('redemptions') @HttpCode(200) redeem(
    @Headers('authorization') auth: unknown,
    @Body(new SchemaValidationPipe(redemptionSchema)) body: RedemptionIntent,
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.redemption.redeem(bearerToken(auth), body);
  }
  @Get() summary(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.summary(bearerToken(auth));
  }
  @Get('records') records(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(experiencePageSchema))
    query: ExperiencePageQuery,
  ) {
    return this.service.recordsPage(bearerToken(auth), query);
  }
  @Get('appearance') appearance(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.appearance(bearerToken(auth));
  }
  @Put('appearance') @HttpCode(200) select(
    @Headers('authorization') auth: unknown,
    @Body(new SchemaValidationPipe(appearanceSchema)) body: AppearanceIntent,
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.selectAppearance(bearerToken(auth), body);
  }
  @Post('sign-in') @HttpCode(200) signIn(
    @Headers('authorization') auth: unknown,
    @Body(new SchemaValidationPipe(signInSchema)) body: { requestId: string },
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.signIn(bearerToken(auth), body.requestId);
  }
  @Get('requests/:requestId') receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(experienceIdSchema))
    id: string,
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.receipt(bearerToken(auth), id);
  }
  @Get('unlocks') unlocks(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.unlocks(bearerToken(auth));
  }
  @Put('unlocks/:noticeId/ack') @HttpCode(200) ack(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(experienceIdSchema)) id: string,
    @Body(new SchemaValidationPipe(experienceEmptySchema))
    _body: Record<string, never>,
    @Query(new SchemaValidationPipe(experienceEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.acknowledge(bearerToken(auth), id);
  }
}
