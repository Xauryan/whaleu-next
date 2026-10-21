import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { bearerToken } from '../../identity/tokens.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  MediaMultipartInterceptor,
  observedMultipart,
} from '../../media/multipart-ingress.js';
import {
  MediaErrorResponses,
  MediaPrivateResponse,
  mediaBinaryResponseHeaders,
  mediaResponseHeaders,
} from '../../media/openapi.js';
import {
  cancelProfileCoverMediaRequestSchema,
  profileCoverMediaGrantSchema,
  profileCoverMediaRecoverySchema,
  profileCoverMediaStatusSchema,
  profileCoverMediaUploadObservedSchema,
} from '../../media/contracts-profile-cover.js';
import type { MediaVariantName } from '../../media/contracts.js';
import { ProfileCoverService, PROFILE_COVER_RUNTIME } from './service.js';
import type { ProfileCoverRuntime } from './service.js';
import { ProfileCoverUploadApplication } from './upload-application.js';
import { ProfileCoverDelivery } from './delivery.js';
import {
  coverCapabilitiesSchema,
  coverCommandRecoverySchema,
  coverCommandCancelSchema,
  coverCommandSchema,
  coverPrepareSchema,
  coverReceiptSchema,
  coverVariantSchema,
  profileCoverMediaId,
} from './contracts.js';
import { coverCurrentSchema } from './selection-contract.js';
const empty = z.strictObject({});
const emptyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(empty)],
};
const idOptions = {
  schema: profileCoverMediaId,
  pipes: [new SchemaValidationPipe(profileCoverMediaId)],
};
function optionalBearer(auth: unknown): string | null {
  return auth === undefined ? null : bearerToken(auth);
}
@Injectable()
export class ProfileCoverMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(ProfileCoverUploadApplication)
    upload: ProfileCoverUploadApplication,
    @Inject(PROFILE_COVER_RUNTIME) runtime: ProfileCoverRuntime | null,
  ) {
    super(upload, runtime?.ingressStorage ?? null);
  }
}
@ApiTags('Profile covers')
@ApiBearerAuth('accessToken')
@MediaErrorResponses()
@Controller('v1/me/profile')
export class ProfileCoverOwnedController {
  constructor(
    @Inject(ProfileCoverService) private readonly owner: ProfileCoverService,
    @Inject(ProfileCoverUploadApplication)
    private readonly upload: ProfileCoverUploadApplication,
  ) {}
  @Get('cover-capabilities')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readOwnProfileCoverCapabilities' })
  @ApiOkResponse({
    standardSchema: coverCapabilitiesSchema,
    headers: mediaResponseHeaders,
  })
  capabilities(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
  ) {
    return this.owner.capabilities(bearerToken(auth));
  }
  @Get('cover')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readOwnProfileCover' })
  @ApiOkResponse({
    standardSchema: coverCurrentSchema,
    headers: mediaResponseHeaders,
  })
  current(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
  ) {
    return this.owner.ownCurrent(bearerToken(auth));
  }
  @Post('cover-commands')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'selectProfileCover' })
  @ApiOkResponse({
    standardSchema: coverReceiptSchema,
    headers: mediaResponseHeaders,
  })
  command(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: coverCommandSchema,
      pipes: [new SchemaValidationPipe(coverCommandSchema)],
    })
    body: unknown,
  ) {
    return this.owner.command(bearerToken(auth), body);
  }
  @Get('cover-command-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverProfileCoverCommand' })
  @ApiOkResponse({
    standardSchema: coverCommandRecoverySchema,
    headers: mediaResponseHeaders,
  })
  commandRecovery(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return this.owner.recoverCommand(bearerToken(auth), id);
  }
  @Post('cover-command-requests/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'cancelProfileCoverCommand',
    description:
      'Exact original key/hash fence. A committed selection wins and cannot be undone by cancellation.',
  })
  @ApiOkResponse({
    standardSchema: coverCommandRecoverySchema,
    headers: mediaResponseHeaders,
  })
  commandCancel(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body({
      schema: coverCommandCancelSchema,
      pipes: [new SchemaValidationPipe(coverCommandCancelSchema)],
    })
    body: unknown,
  ) {
    return this.owner.cancelCommand(bearerToken(auth), id, body);
  }
  @Post('cover-edits')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'prepareProfileCoverEdit' })
  @ApiOkResponse({
    standardSchema: profileCoverMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: coverPrepareSchema,
      pipes: [new SchemaValidationPipe(coverPrepareSchema)],
    })
    body: unknown,
  ) {
    return this.upload.prepare(bearerToken(auth), body);
  }
  @Get('cover-edit-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverProfileCoverEdit' })
  @ApiOkResponse({
    standardSchema: profileCoverMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  recover(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return this.upload.recover(bearerToken(auth), id);
  }
  @Post('cover-edit-requests/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'cancelProfileCoverEditRequest' })
  @ApiOkResponse({
    standardSchema: profileCoverMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body({
      schema: cancelProfileCoverMediaRequestSchema,
      pipes: [new SchemaValidationPipe(cancelProfileCoverMediaRequestSchema)],
    })
    body: unknown,
  ) {
    return this.upload.cancelRequest(bearerToken(auth), id, body);
  }
  @Get('cover-edits/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readProfileCoverEdit' })
  @ApiOkResponse({
    standardSchema: profileCoverMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  status(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return this.upload.status(bearerToken(auth), id);
  }
  @Post('cover-edits/:id/finalize')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'finalizeProfileCoverEdit' })
  @ApiOkResponse({
    standardSchema: profileCoverMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  finalize(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.upload.finalize(bearerToken(auth), id);
  }
  @Post('cover-edits/:id/grant')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'grantProfileCoverUpload' })
  @ApiOkResponse({
    standardSchema: profileCoverMediaGrantSchema,
    headers: mediaResponseHeaders,
  })
  grant(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body(emptyOptions) _body: unknown,
  ) {
    return this.upload.grant(bearerToken(auth), id);
  }
  @Post('cover-edits/:id/uploads/:grantId')
  @HttpCode(200)
  @MediaPrivateResponse()
  @UseInterceptors(ProfileCoverMultipartInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ operationId: 'uploadProfileCoverBytes' })
  @ApiOkResponse({
    standardSchema: profileCoverMediaUploadObservedSchema,
    headers: mediaResponseHeaders,
  })
  observed(
    @Param('id', idOptions) id: string,
    @Param('grantId', idOptions) _grant: string,
    @Query(emptyOptions) _query: unknown,
    @Req() request: Request,
  ) {
    return this.upload.observed(id, observedMultipart(request));
  }
}
@ApiTags('Profile covers')
@MediaErrorResponses()
@Controller('v1')
export class ProfileCoverPublicController {
  constructor(
    @Inject(ProfileCoverService) private readonly owner: ProfileCoverService,
    @Inject(ProfileCoverDelivery)
    private readonly delivery: ProfileCoverDelivery,
  ) {}
  @Get('profiles/:id/cover')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readPublicProfileCover',
    description:
      'Current Profile-only guest/session eligibility. An invalid Authorization header never downgrades to guest.',
  })
  @ApiOkResponse({
    standardSchema: coverCurrentSchema,
    headers: mediaResponseHeaders,
  })
  current(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return this.owner.publicCurrent(optionalBearer(auth), id);
  }
  @Get('profiles/:id/cover/:appearanceId/:variant')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readProfileCoverVariant',
    description:
      'Two current-authorized short transactions surround a paused exact-object open. No original, redirect, Range or public cache.',
  })
  @ApiOkResponse({
    content: {
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
      'image/png': { schema: { type: 'string', format: 'binary' } },
    },
    headers: mediaBinaryResponseHeaders,
  })
  async open(
    @Headers('authorization') auth: unknown,
    @Headers('range') range: string | undefined,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Param('appearanceId', idOptions) appearanceId: string,
    @Param('variant', {
      schema: coverVariantSchema,
      pipes: [new SchemaValidationPipe(coverVariantSchema)],
    })
    variant: MediaVariantName,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.delivery.open(
      optionalBearer(auth),
      id,
      appearanceId,
      variant,
      request.socket,
      range,
    );
    response.once('close', result.abort);
    try {
      for (const [key, value] of Object.entries(result.headers))
        response.setHeader(key, value);
      await pipeline(result.stream, response);
    } finally {
      result.abort();
    }
  }
}
