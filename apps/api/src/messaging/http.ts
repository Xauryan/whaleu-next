import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { safeErrorResponseSchema } from '../http/error-contracts.js';
export const dmResponseHeaders = {
  'cache-control': { schema: { type: 'string' as const, enum: ['no-store'] } },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
export function PrivateMessageResponses() {
  return applyDecorators(
    ...[400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((status) =>
      ApiResponse({
        status,
        description:
          'Sanitized private-message failure. No hidden participant or payload disclosure; unknown authority remains unavailable.',
        standardSchema: safeErrorResponseSchema,
        headers:
          status === 429
            ? {
                ...dmResponseHeaders,
                'retry-after': { schema: { type: 'string', enum: ['60'] } },
              }
            : dmResponseHeaders,
      }),
    ),
  );
}
