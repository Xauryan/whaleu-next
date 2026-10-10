import { applyDecorators, Header } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { safeErrorResponseSchema } from '../http/error-contracts.js';

export const mediaResponseHeaders = {
  'cache-control': {
    schema: { type: 'string' as const, enum: ['private, no-store'] },
  },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
export const mediaBinaryResponseHeaders = {
  ...mediaResponseHeaders,
  'x-content-type-options': {
    schema: { type: 'string' as const, enum: ['nosniff'] },
  },
  'accept-ranges': { schema: { type: 'string' as const, enum: ['none'] } },
  'content-length': {
    schema: { type: 'string' as const, pattern: '^[1-9][0-9]*$' },
  },
};

export function MediaPrivateResponse() {
  return applyDecorators(
    Header('Cache-Control', 'private, no-store'),
    Header('Vary', 'Authorization'),
  );
}

export function MediaErrorResponses() {
  return applyDecorators(
    ...[
      [
        400,
        'Strict validation rejects unknown query/body keys and invalid identifiers or variants.',
      ],
      [
        401,
        'Current valid opaque bearer session required; no anonymous access.',
      ],
      [403, 'Current owner or parent authority denies access.'],
      [
        404,
        'Missing or inaccessible intent/binding; no hidden parent or storage disclosure.',
      ],
      [409, 'MEDIA_NOT_READY or command conflict; refresh intent status.'],
      [413, 'Request exceeds body size limit.'],
      [415, 'Unsupported request format.'],
      [500, 'Unexpected failure is sanitized.'],
      [
        503,
        'MEDIA_UNAVAILABLE: default runtime is disabled. Missing storage, transform, safety or owner authority fails closed. Range requests are unsupported and return MEDIA_UNAVAILABLE; no partial content or redirect.',
      ],
    ].map(([status, description]) =>
      ApiResponse({
        status: status as number,
        description: description as string,
        standardSchema: safeErrorResponseSchema,
        headers: mediaResponseHeaders,
      }),
    ),
  );
}
