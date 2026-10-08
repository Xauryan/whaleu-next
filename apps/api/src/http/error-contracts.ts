import { z } from 'zod';

const safeErrorFields = {
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
};
export const safeErrorResponseSchema = z
  .strictObject({ error: z.strictObject(safeErrorFields) })
  .meta({ id: 'SafeErrorResponse' });
export type SafeErrorResponse = z.output<typeof safeErrorResponseSchema>;

/** This legacy recovery reference is only emitted by the maintenance owner. */
export const titleMaintenanceContinuationErrorSchema = z.strictObject({
  error: z.strictObject({
    ...safeErrorFields,
    code: z.literal('EXPERIENCE_MAINTENANCE_CONTINUATION_CONFLICT'),
    successorRequestId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
  }),
});
export type TitleMaintenanceContinuationError = z.output<
  typeof titleMaintenanceContinuationErrorSchema
>;

const messages: Readonly<
  Record<number, { readonly code: string; readonly message: string }>
> = {
  400: { code: 'BAD_REQUEST', message: 'Invalid request' },
  401: { code: 'UNAUTHORIZED', message: 'Authentication required' },
  403: { code: 'FORBIDDEN', message: 'Access denied' },
  404: { code: 'NOT_FOUND', message: 'Resource not found' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
  409: { code: 'CONFLICT', message: 'Request conflicts with current state' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request is too large' },
  415: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Unsupported request format',
  },
  422: { code: 'UNPROCESSABLE_ENTITY', message: 'Invalid request' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests' },
  503: { code: 'NOT_READY', message: 'Service is not ready' },
};

export function safeHttpErrorDescription(status: number) {
  return (
    messages[status] ?? { code: 'INTERNAL_ERROR', message: 'Request failed' }
  );
}
