import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { idSchema, requestIdSchema } from '../contracts.js';
import { emptyFormationQuerySchema, joinFormationSchema } from './contracts.js';
import type { JoinFormation } from './contracts.js';
import { FormationService } from './service.js';
@Controller('v1/community/posts')
export class FormationController {
  constructor(
    @Inject(FormationService) private readonly formations: FormationService,
  ) {}
  @Get(':postId/formation') read(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyFormationQuerySchema))
    _query: Record<string, never>,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.formations.get(bearerToken(auth), id);
  }
  @Get(':postId/formation/contacts') contacts(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyFormationQuerySchema))
    _query: Record<string, never>,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.formations.contacts(bearerToken(auth), id);
  }
  @Post(':postId/formation/memberships') join(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyFormationQuerySchema))
    _query: Record<string, never>,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(joinFormationSchema)) input: JoinFormation,
  ) {
    return this.formations.join(bearerToken(auth), id, input);
  }
}
@Controller('v1/me/community')
export class FormationRecoveryController {
  constructor(
    @Inject(FormationService) private readonly formations: FormationService,
  ) {}
  @Get('formation-requests/:requestId') receipt(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyFormationQuerySchema))
    _query: Record<string, never>,
    @Param('requestId', new SchemaValidationPipe(requestIdSchema)) id: string,
  ) {
    return this.formations.receipt(bearerToken(auth), id);
  }
  @Get('formation-memberships/:postId') own(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyFormationQuerySchema))
    _query: Record<string, never>,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.formations.own(bearerToken(auth), id);
  }
}
