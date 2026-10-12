import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { SchemaValidationPipe } from '../http/validation.js';
import { RatingResponses, ratingResponseHeaders } from '../http/rating-http.js';
import { bearerToken } from '../identity/tokens.js';
import { RatingRequestGuard } from '../request-throttling/rating-request.guard.js';
import * as c from './contracts.js';
import type { MajorQuery } from './contracts.js';
import { MajorsService } from './service.js';
const empty = c.majorEmptySchema,
  emptyBody = z.union([z.undefined(), empty]);
@ApiTags('Major directory')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/majors')
export class MajorsController {
  constructor(@Inject(MajorsService) private readonly majors: MajorsService) {}
  @Get('departments')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDepartments' })
  @ApiOkResponse({
    standardSchema: c.majorDepartmentsSchema,
    headers: ratingResponseHeaders,
  })
  departments(
    @Headers('authorization') auth: unknown,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.majors.departments(bearerToken(auth));
  }
  @Get('')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDirectory' })
  @ApiOkResponse({
    standardSchema: c.majorPageSchema,
    headers: ratingResponseHeaders,
  })
  page(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: c.majorQuerySchema,
      pipes: [new SchemaValidationPipe(c.majorQuerySchema)],
    })
    query: MajorQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.majors.page(bearerToken(auth), query);
  }
  @Get(':id/related')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorRelated' })
  @ApiOkResponse({
    standardSchema: c.majorPageSchema,
    headers: ratingResponseHeaders,
  })
  related(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.majorIdSchema)) id: string,
    @Query({
      schema: c.majorRelatedQuerySchema,
      pipes: [new SchemaValidationPipe(c.majorRelatedQuerySchema)],
    })
    query: z.infer<typeof c.majorRelatedQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.majors.related(bearerToken(auth), id, query.limit);
  }
  @Get(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDetail' })
  @ApiOkResponse({
    standardSchema: c.majorDetailSchema,
    headers: ratingResponseHeaders,
  })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(c.majorIdSchema)) id: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.majors.detail(bearerToken(auth), id);
  }
}
