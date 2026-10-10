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
  cancelProfileMediaRequestSchema,
  profileMediaGrantSchema,
  profileMediaRecoverySchema,
  profileMediaStatusSchema,
  profileMediaUploadObservedSchema,
} from '../../media/contracts-profile.js';
import type { MediaVariantName } from '../../media/contracts.js';
import { ProfileAvatarService, PROFILE_AVATAR_RUNTIME } from './service.js';
import type { ProfileAvatarRuntime } from './service.js';
import { ProfileAvatarUploadApplication } from './upload-application.js';
import { ProfileAvatarDelivery } from './delivery.js';
import {
  avatarCommandRecoverySchema,
  avatarCommandCancelSchema,
  avatarCommandSchema,
  avatarPrepareSchema,
  avatarReceiptSchema,
  avatarVariantSchema,
  profileMediaId,
} from './contracts.js';
import {
  avatarCatalogSchema,
  avatarCurrentSchema,
} from './selection-contract.js';
const empty = z.strictObject({});
const emptyOptions = {
  schema: empty,
  pipes: [new SchemaValidationPipe(empty)],
};
const idOptions = {
  schema: profileMediaId,
  pipes: [new SchemaValidationPipe(profileMediaId)],
};
function optionalBearer(auth: unknown): string | null {
  return auth === undefined ? null : bearerToken(auth);
}
@Injectable()
export class ProfileAvatarMultipartInterceptor extends MediaMultipartInterceptor {
  constructor(
    @Inject(ProfileAvatarUploadApplication)
    upload: ProfileAvatarUploadApplication,
    @Inject(PROFILE_AVATAR_RUNTIME) runtime: ProfileAvatarRuntime | null,
  ) {
    super(upload, runtime?.ingressStorage ?? null);
  }
}
@ApiTags('Profile avatars')
@ApiBearerAuth('accessToken')
@MediaErrorResponses()
@Controller('v1/me/profile')
export class ProfileAvatarOwnedController {
  constructor(
    @Inject(ProfileAvatarService) private readonly owner: ProfileAvatarService,
    @Inject(ProfileAvatarUploadApplication)
    private readonly upload: ProfileAvatarUploadApplication,
  ) {}
  @Get('avatar')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readOwnProfileAvatar' })
  @ApiOkResponse({
    standardSchema: avatarCurrentSchema,
    headers: mediaResponseHeaders,
  })
  current(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
  ) {
    return this.owner.ownCurrent(bearerToken(auth));
  }
  @Post('avatar-commands')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'selectProfileAvatar' })
  @ApiOkResponse({
    standardSchema: avatarReceiptSchema,
    headers: mediaResponseHeaders,
  })
  command(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: avatarCommandSchema,
      pipes: [new SchemaValidationPipe(avatarCommandSchema)],
    })
    body: unknown,
  ) {
    return this.owner.command(bearerToken(auth), body);
  }
  @Get('avatar-command-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverProfileAvatarCommand' })
  @ApiOkResponse({
    standardSchema: avatarCommandRecoverySchema,
    headers: mediaResponseHeaders,
  })
  commandRecovery(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return this.owner.recoverCommand(bearerToken(auth), id);
  }
  @Post('avatar-command-requests/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'cancelProfileAvatarCommand',
    description:
      'Exact original key/hash fence. A committed selection wins and cannot be undone by cancellation.',
  })
  @ApiOkResponse({
    standardSchema: avatarCommandRecoverySchema,
    headers: mediaResponseHeaders,
  })
  commandCancel(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body({
      schema: avatarCommandCancelSchema,
      pipes: [new SchemaValidationPipe(avatarCommandCancelSchema)],
    })
    body: unknown,
  ) {
    return this.owner.cancelCommand(bearerToken(auth), id, body);
  }
  @Post('avatar-edits')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'prepareProfileAvatarEdit' })
  @ApiOkResponse({
    standardSchema: profileMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Body({
      schema: avatarPrepareSchema,
      pipes: [new SchemaValidationPipe(avatarPrepareSchema)],
    })
    body: unknown,
  ) {
    return this.upload.prepare(bearerToken(auth), body);
  }
  @Get('avatar-edit-requests/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'recoverProfileAvatarEdit' })
  @ApiOkResponse({
    standardSchema: profileMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  recover(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return this.upload.recover(bearerToken(auth), id);
  }
  @Post('avatar-edit-requests/:id/cancel')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'cancelProfileAvatarEditRequest' })
  @ApiOkResponse({
    standardSchema: profileMediaRecoverySchema,
    headers: mediaResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
    @Body({
      schema: cancelProfileMediaRequestSchema,
      pipes: [new SchemaValidationPipe(cancelProfileMediaRequestSchema)],
    })
    body: unknown,
  ) {
    return this.upload.cancelRequest(bearerToken(auth), id, body);
  }
  @Get('avatar-edits/:id')
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'readProfileAvatarEdit' })
  @ApiOkResponse({
    standardSchema: profileMediaStatusSchema,
    headers: mediaResponseHeaders,
  })
  status(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return this.upload.status(bearerToken(auth), id);
  }
  @Post('avatar-edits/:id/finalize')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'finalizeProfileAvatarEdit' })
  @ApiOkResponse({
    standardSchema: profileMediaStatusSchema,
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
  @Post('avatar-edits/:id/grant')
  @HttpCode(200)
  @MediaPrivateResponse()
  @ApiOperation({ operationId: 'grantProfileAvatarUpload' })
  @ApiOkResponse({
    standardSchema: profileMediaGrantSchema,
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
  @Post('avatar-edits/:id/uploads/:grantId')
  @HttpCode(200)
  @MediaPrivateResponse()
  @UseInterceptors(ProfileAvatarMultipartInterceptor)
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
  @ApiOperation({ operationId: 'uploadProfileAvatarBytes' })
  @ApiOkResponse({
    standardSchema: profileMediaUploadObservedSchema,
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
@ApiTags('Profile avatars')
@MediaErrorResponses()
@Controller('v1')
export class ProfileAvatarPublicController {
  constructor(
    @Inject(ProfileAvatarService) private readonly owner: ProfileAvatarService,
    @Inject(ProfileAvatarDelivery)
    private readonly delivery: ProfileAvatarDelivery,
  ) {}
  @Get('profile-avatar-catalog')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readProfileAvatarCatalog',
    description:
      'Unavailable unless an explicit catalog is configured. No real 91-item package is included.',
  })
  @ApiOkResponse({
    standardSchema: avatarCatalogSchema,
    headers: mediaResponseHeaders,
  })
  catalog(@Query(emptyOptions) _query: unknown) {
    return this.owner.catalog();
  }
  @Get('profiles/:id/avatar')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readPublicProfileAvatar',
    description:
      'Current Profile-only guest/session eligibility. An invalid Authorization header never downgrades to guest.',
  })
  @ApiOkResponse({
    standardSchema: avatarCurrentSchema,
    headers: mediaResponseHeaders,
  })
  current(
    @Headers('authorization') auth: unknown,
    @Query(emptyOptions) _query: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return this.owner.publicCurrent(optionalBearer(auth), id);
  }
  @Get('profiles/:id/avatar/:appearanceId/:variant')
  @MediaPrivateResponse()
  @ApiOperation({
    operationId: 'readProfileAvatarVariant',
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
      schema: avatarVariantSchema,
      pipes: [new SchemaValidationPipe(avatarVariantSchema)],
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
