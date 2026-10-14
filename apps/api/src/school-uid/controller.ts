import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Query,
  Body,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SchemaValidationPipe } from '../http/validation.js';
import { bearerToken } from '../identity/tokens.js';
import { SchoolUidService } from './service.js';
import { schoolUidSchema, schoolUidEmptyQuerySchema } from './contracts.js';
import { schoolIdentityEmptyBodySchema } from '../school-identity/contracts.js';
@ApiTags('School UID')
@ApiBearerAuth('accessToken')
@Controller('v1/me')
export class SchoolUidController {
  constructor(
    @Inject(SchoolUidService) private readonly service: SchoolUidService,
  ) {}
  @Get('school-uid')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ownSchoolUid' })
  @ApiOkResponse({ standardSchema: schoolUidSchema })
  own(
    @Headers('authorization') authorization: unknown,
    @Query({
      schema: schoolUidEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(schoolUidEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(schoolIdentityEmptyBodySchema))
    _body: unknown,
  ) {
    return this.service.own(bearerToken(authorization));
  }
}
