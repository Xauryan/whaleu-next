import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { safeErrorResponseSchema } from './error-contracts.js';
export const ratingResponseHeaders = {
  'cache-control': { schema: { type: 'string' as const, enum: ['no-store'] } },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
export function RatingResponses() {
  return applyDecorators(
    ...[400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((status) =>
      ApiResponse({
        status,
        description:
          'Strict, current-authorized, sanitized error. Unknown review/verification/feature facts fail closed. Receipts never disclose current private fields.',
        standardSchema: safeErrorResponseSchema,
        headers:
          status === 429
            ? {
                ...ratingResponseHeaders,
                'retry-after': { schema: { type: 'string', enum: ['60'] } },
              }
            : ratingResponseHeaders,
      }),
    ),
  );
}
