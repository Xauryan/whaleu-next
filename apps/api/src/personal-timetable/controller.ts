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
import { SchemaValidationPipe } from '../http/validation.js';
import { bearerToken } from '../identity/tokens.js';
import {
  timetableCommandSchema,
  timetableEmptySchema,
  timetableIdSchema,
} from './contracts.js';
import type { TimetableCommand } from './contracts.js';
import { PersonalTimetableService } from './service.js';
@Controller('v1/me/timetable')
export class PersonalTimetableController {
  constructor(
    @Inject(PersonalTimetableService)
    private readonly service: PersonalTimetableService,
  ) {}
  @Get('terms')
  @Header('Cache-Control', 'private, no-store')
  list(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(timetableEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.list(bearerToken(auth));
  }
  @Get('terms/:termId')
  @Header('Cache-Control', 'private, no-store')
  detail(
    @Headers('authorization') auth: unknown,
    @Param('termId', new SchemaValidationPipe(timetableIdSchema))
    termId: string,
    @Query(new SchemaValidationPipe(timetableEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.detail(bearerToken(auth), termId);
  }
  @Post('commands')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  execute(
    @Headers('authorization') auth: unknown,
    @Body(new SchemaValidationPipe(timetableCommandSchema))
    body: TimetableCommand,
    @Query(new SchemaValidationPipe(timetableEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.execute(bearerToken(auth), body);
  }
  @Get('requests/:requestId')
  @Header('Cache-Control', 'private, no-store')
  recover(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(timetableIdSchema))
    requestId: string,
    @Query(new SchemaValidationPipe(timetableEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.recover(bearerToken(auth), requestId);
  }
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(timetableIdSchema))
    requestId: string,
    @Body(new SchemaValidationPipe(timetableCommandSchema))
    body: TimetableCommand,
    @Query(new SchemaValidationPipe(timetableEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.service.cancel(bearerToken(auth), requestId, body);
  }
}
