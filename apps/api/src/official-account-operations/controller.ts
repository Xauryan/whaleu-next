import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiOkResponse,
  ApiAcceptedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
type SwaggerBodySchema = Extract<
  Parameters<typeof ApiBody>[0],
  { schema: unknown }
>['schema'];
const officialBody = (schema: z.ZodType) =>
  ApiBody({
    schema: z.toJSONSchema(schema, {
      target: 'openapi-3.0',
    }) as SwaggerBodySchema,
  });
import { bearerToken } from '../identity/tokens.js';
import { ApplicationError } from '../http/application-error.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { OfficialAccountOperationsService } from './service.js';
import { OfficialCallbackBoundary } from './callback-ledger.js';
import { officialUuid } from './profile.js';
import {
  officialConfigCommand,
  officialPreviewRequest,
  officialManualPreview,
  officialDraftCommand,
  officialPublishCommand,
  officialOriginalCommand,
} from './contracts.js';
import { OfficialRequestGuard } from './request-guard.js';
import {
  officialReceiptSchema,
  officialCancellationTombstoneSchema,
  officialStatusSchema,
  officialCommandResultSchema,
  officialPreviewSchema,
  officialConfigSchema,
  officialCapabilitiesSchema,
  officialPublishConfirmationSchema,
} from './contracts.js';
import { decodeOfficialJson } from './http.js';
const id = {
  schema: officialUuid,
  pipes: [new SchemaValidationPipe(officialUuid)],
};
const input = (body: unknown) =>
  Buffer.isBuffer(body) ? decodeOfficialJson(body) : body;
function sameOrigin(request: Request) {
  const origin = request.get('origin');
  if (origin && origin !== `${request.protocol}://${request.get('host')}`)
    throw new ApplicationError('OFFICIAL_AUTHORITY_REQUIRED');
}
function privateHeaders(response: Response) {
  response.set({
    'Cache-Control': 'private, no-store',
    Vary: 'Authorization',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
}
@ApiTags('Official account operations')
@ApiBearerAuth('accessToken')
@UseGuards(OfficialRequestGuard)
@Controller('v1/me/official-account-operations')
export class OfficialAccountOperationsController {
  constructor(
    @Inject(OfficialAccountOperationsService)
    private readonly service: OfficialAccountOperationsService,
  ) {}
  @Get('capabilities')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'officialCapabilities' })
  @ApiOkResponse({ standardSchema: officialCapabilitiesSchema })
  capabilities(
    @Headers('authorization') auth: unknown,
    @Query(
      new SchemaValidationPipe(z.strictObject({ programId: officialUuid })),
    )
    query: { programId: string },
  ) {
    return this.service.capabilities(bearerToken(auth), query.programId);
  }
  @Get('programs/:programId/config')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'officialConfig' })
  @ApiOkResponse({ standardSchema: officialConfigSchema })
  config(
    @Headers('authorization') auth: unknown,
    @Param('programId', id) programId: string,
    @Query(new SchemaValidationPipe(z.strictObject({}))) _query: unknown,
  ) {
    return this.service.config(bearerToken(auth), programId);
  }
  @Post('config-commands')
  @officialBody(officialConfigCommand)
  @ApiOperation({ operationId: 'officialSaveConfig' })
  @ApiOkResponse({ standardSchema: officialCommandResultSchema })
  async save(
    @Headers('authorization') auth: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    privateHeaders(response);
    response.status(200);
    const { receipt, status } = await this.service.save(
      bearerToken(auth),
      input(body),
    );
    return { receipt, status };
  }
  @Post('previews')
  @officialBody(officialPreviewRequest)
  @ApiOperation({ operationId: 'officialPreview' })
  @ApiOkResponse({ standardSchema: officialPreviewSchema })
  preview(
    @Headers('authorization') auth: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    privateHeaders(response);
    response.status(200);
    return this.service.preview(bearerToken(auth), input(body));
  }
  @Post('test-commands')
  @officialBody(officialDraftCommand)
  @ApiOperation({ operationId: 'officialTestDraft' })
  @ApiOkResponse({ standardSchema: officialCommandResultSchema })
  @ApiAcceptedResponse({ standardSchema: officialCommandResultSchema })
  async test(
    @Headers('authorization') auth: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    privateHeaders(response);
    const { replay, ...result } = await this.service.createDraft(
      bearerToken(auth),
      input(body),
    );
    response.status(replay ? 200 : 202);
    return result;
  }
  @Get('requests/:requestId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'officialRequestStatus' })
  @ApiOkResponse({
    standardSchema: z.union([
      z.strictObject({ state: z.literal('not_recorded') }),
      officialCancellationTombstoneSchema,
      z.strictObject({
        state: z.literal('recorded'),
        receipt: officialReceiptSchema,
        status: officialStatusSchema,
      }),
    ]),
  })
  status(
    @Headers('authorization') auth: unknown,
    @Param('requestId', id) requestId: string,
    @Query(new SchemaValidationPipe(z.strictObject({}))) _query: unknown,
  ) {
    return this.service.status(bearerToken(auth), requestId);
  }
  @Post('requests/:requestId/cancel')
  @officialBody(z.strictObject({ intent: officialOriginalCommand }))
  @ApiOperation({ operationId: 'officialCancel' })
  @ApiOkResponse({
    standardSchema: z.union([
      officialCommandResultSchema,
      officialCancellationTombstoneSchema,
    ]),
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', id) requestId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    privateHeaders(response);
    response.status(200);
    return this.service.cancel(bearerToken(auth), requestId, input(body));
  }
  @Post('requests/:requestId/resume')
  @officialBody(z.strictObject({ intent: officialOriginalCommand }))
  @ApiOperation({ operationId: 'officialResume' })
  @ApiOkResponse({ standardSchema: officialCommandResultSchema })
  resume(
    @Headers('authorization') auth: unknown,
    @Param('requestId', id) requestId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    privateHeaders(response);
    response.status(200);
    return this.service.resume(bearerToken(auth), requestId, input(body));
  }
  @Get('programs/:programId/slots/:slotId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'officialSlotStatus' })
  slot(
    @Headers('authorization') auth: unknown,
    @Param('programId', id) programId: string,
    @Param('slotId', id) slotId: string,
  ) {
    return this.service.slot(bearerToken(auth), programId, slotId);
  }
  @Post('operator/previews')
  @officialBody(officialManualPreview)
  @ApiOperation({ operationId: 'officialManualPreview' })
  @ApiOkResponse({ standardSchema: officialPreviewSchema })
  manualPreview(
    @Headers('authorization') auth: unknown,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    sameOrigin(request);
    privateHeaders(response);
    response.status(200);
    return this.service.preview(bearerToken(auth), input(body), true);
  }
  @Post('operator/draft-commands')
  @officialBody(officialDraftCommand)
  @ApiOperation({ operationId: 'officialManualDraft' })
  @ApiOkResponse({ standardSchema: officialCommandResultSchema })
  @ApiAcceptedResponse({ standardSchema: officialCommandResultSchema })
  async manualDraft(
    @Headers('authorization') auth: unknown,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    sameOrigin(request);
    privateHeaders(response);
    const { replay, ...result } = await this.service.createDraft(
      bearerToken(auth),
      input(body),
      true,
    );
    response.status(replay ? 200 : 202);
    return result;
  }
  @Post('operator/publish-previews')
  @officialBody(z.strictObject({ draftRef: officialUuid }))
  @ApiOperation({ operationId: 'officialPublishPreview' })
  @ApiOkResponse({ standardSchema: officialPublishConfirmationSchema })
  publishPreview(
    @Headers('authorization') auth: unknown,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    sameOrigin(request);
    privateHeaders(response);
    response.status(200);
    return this.service.publishPreview(bearerToken(auth), input(body));
  }
  @Post('operator/publish-commands')
  @officialBody(officialPublishCommand)
  @ApiOperation({ operationId: 'officialPublish' })
  @ApiOkResponse({ standardSchema: officialCommandResultSchema })
  @ApiAcceptedResponse({ standardSchema: officialCommandResultSchema })
  async publish(
    @Headers('authorization') auth: unknown,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    sameOrigin(request);
    privateHeaders(response);
    const { replay, ...result } = await this.service.publish(
      bearerToken(auth),
      input(body),
    );
    response.status(replay ? 200 : 202);
    return result;
  }
}
@ApiTags('Synthetic official callback')
@Controller('v1/official-account-callbacks')
export class OfficialAccountCallbackController {
  constructor(
    @Inject(OfficialCallbackBoundary)
    private readonly boundary: OfficialCallbackBoundary,
  ) {}
  @Get(':registrationId')
  @ApiOperation({ operationId: 'officialCallbackChallenge' })
  async challenge(
    @Param('registrationId') registrationId: string,
    @Query() query: unknown,
    @Headers('x-synthetic-signature') signature: unknown,
    @Res() response: Response,
  ) {
    privateHeaders(response);
    const result = await this.boundary.challenge(
      registrationId,
      query,
      typeof signature === 'string' ? signature : undefined,
    );
    if (result.retryAfter)
      response.set('Retry-After', String(result.retryAfter));
    return response.status(result.status).json(result.body);
  }
  @Post(':registrationId')
  @ApiOperation({ operationId: 'officialCallbackReceive' })
  async receive(
    @Param('registrationId') registrationId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    privateHeaders(response);
    const result = await this.boundary.receive(registrationId, {
      rawBody: Buffer.isBuffer(body) ? body : Buffer.alloc(0),
      ...(request.get('content-type') === undefined
        ? {}
        : { contentType: request.get('content-type')! }),
      ...(request.get('content-encoding') === undefined
        ? {}
        : { contentEncoding: request.get('content-encoding')! }),
      ...(request.get('x-synthetic-signature') === undefined
        ? {}
        : { signature: request.get('x-synthetic-signature')! }),
    });
    if (result.retryAfter)
      response.set('Retry-After', String(result.retryAfter));
    return response.status(result.status).json(result.body);
  }
}
