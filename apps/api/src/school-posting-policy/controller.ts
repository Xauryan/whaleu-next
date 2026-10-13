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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SchemaValidationPipe } from '../http/validation.js';
import { bearerToken } from '../identity/tokens.js';
import { SchoolPostingPolicyService } from './service.js';
import { SchoolPostingPolicyRequestGuard } from './request-guard.js';
import {
  schoolPostingIdSchema,
  schoolPostingRequestIdSchema,
  postingCancelSchema,
  postingEmptyBodySchema,
  postingEmptyQuerySchema,
  saveSchoolPostingPolicySchema,
  schoolPostingQuerySchema,
  schoolPostingReceiptSchema,
  schoolPostingRecoverySchema,
  schoolPostingViewSchema,
} from './contracts.js';
import type { SaveSchoolPostingPolicy } from './contracts.js';
@ApiTags('School posting policy')
@ApiBearerAuth('accessToken')
@UseGuards(SchoolPostingPolicyRequestGuard)
@Controller('v1/me/school-posting-policy')
export class SchoolPostingPolicyController {
  constructor(
    @Inject(SchoolPostingPolicyService)
    private readonly service: SchoolPostingPolicyService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readSchoolPostingPolicy',
    description:
      'Current original regional ledger; missing and expired evidence remain distinct. True school-admin fixed scope or explicit active super-admin target only. Unknown provenance is read-only. Updated clients may explicitly edit related-campus synchronization through v2 commands.',
  })
  @ApiOkResponse({ standardSchema: schoolPostingViewSchema })
  read(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: schoolPostingQuerySchema,
      pipes: [new SchemaValidationPipe(schoolPostingQuerySchema)],
    })
    query: { regionId?: string },
    @Body(new SchemaValidationPipe(postingEmptyBodySchema))
    _body: unknown,
  ) {
    return this.service.management(bearerToken(auth), query.regionId);
  }
  @Post(':regionId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'saveSchoolPostingPolicy',
    description:
      'Explicit current administrator CAS publication into the same immutable region policy ledger. Preserves exact request key/hash; generates accepted provenance server-side. Only nine ordinary categories; named author, phone, known affiliation and exact Review remain mandatory. Version 2 explicitly controls related-campus synchronization: enable requires accepted current multi-region applicability; disable does not. Legacy commands cannot overwrite enabled sync.',
  })
  @ApiOkResponse({ standardSchema: schoolPostingReceiptSchema })
  save(
    @Headers('authorization') auth: unknown,
    @Param('regionId', {
      schema: schoolPostingIdSchema,
      pipes: [new SchemaValidationPipe(schoolPostingIdSchema)],
    })
    regionId: string,
    @Query({
      schema: postingEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(postingEmptyQuerySchema)],
    })
    _query: unknown,
    @Body({
      schema: saveSchoolPostingPolicySchema,
      pipes: [new SchemaValidationPipe(saveSchoolPostingPolicySchema)],
    })
    command: SaveSchoolPostingPolicy,
  ) {
    return this.service.save(bearerToken(auth), regionId, command);
  }
  @Get('requests/:requestId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'recoverSchoolPostingPolicy',
    description:
      'Authenticated owner-only historical receipt, even after grant revocation. Does not authorize a new write or disclose current policy content.',
  })
  @ApiOkResponse({ standardSchema: schoolPostingRecoverySchema })
  recover(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: schoolPostingRequestIdSchema,
      pipes: [new SchemaValidationPipe(schoolPostingRequestIdSchema)],
    })
    requestId: string,
    @Query({
      schema: postingEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(postingEmptyQuerySchema)],
    })
    _query: unknown,
    @Body(new SchemaValidationPipe(postingEmptyBodySchema))
    _body: unknown,
  ) {
    return this.service.recover(bearerToken(auth), requestId);
  }
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'cancelSchoolPostingPolicy',
    description:
      'Owner exact-key/hash fence serialized with publication. Never reverses a committed revision; reports its original receipt when publication already won.',
  })
  @ApiOkResponse({ standardSchema: schoolPostingRecoverySchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: schoolPostingRequestIdSchema,
      pipes: [new SchemaValidationPipe(schoolPostingRequestIdSchema)],
    })
    requestId: string,
    @Query({
      schema: postingEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(postingEmptyQuerySchema)],
    })
    _query: unknown,
    @Body({
      schema: postingCancelSchema,
      pipes: [new SchemaValidationPipe(postingCancelSchema)],
    })
    command: { requestHash: string },
  ) {
    return this.service.cancel(
      bearerToken(auth),
      requestId,
      command.requestHash,
    );
  }
}
