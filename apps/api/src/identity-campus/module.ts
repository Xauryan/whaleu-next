import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Module,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CampusModule } from '../campus/campus.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import {
  identityCampusEmptyQuerySchema,
  identityCampusRequestIdSchema,
  identityCampusSelectionSchema,
} from './contracts.js';
import type { IdentityCampusIntent } from './contracts.js';
import { IdentityCampusService } from './service.js';
@Controller('v1/me/identity-campus')
export class IdentityCampusController {
  constructor(
    @Inject(IdentityCampusService)
    private readonly selection: IdentityCampusService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  state(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(identityCampusEmptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.selection.state(bearerToken(auth));
  }
  @Put()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  select(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(identityCampusEmptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(identityCampusSelectionSchema))
    body: IdentityCampusIntent,
  ) {
    return this.selection.select(bearerToken(auth), body);
  }
  @Get('requests/:requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(identityCampusRequestIdSchema))
    requestId: string,
    @Query(new SchemaValidationPipe(identityCampusEmptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.selection.receipt(bearerToken(auth), requestId);
  }
}
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    VerificationModule,
    CampusModule,
    SafetyPolicyModule,
  ],
  controllers: [IdentityCampusController],
  providers: [IdentityCampusService],
})
export class IdentityCampusModule {}
