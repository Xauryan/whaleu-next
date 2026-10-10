import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MEDIA_MAX_INPUT_BYTES,
  MEDIA_MAX_OUTPUT_BYTES,
  MEDIA_MAX_PIXELS,
  mediaMimeSchema,
} from '../contracts.js';

export const PROCESS_DEADLINE_MS = 10_000;
export const PROCESS_MEMORY_BYTES = 256 * 1024 * 1024;
export const PROCESS_TEMP_BYTES = 32 * 1024 * 1024;
// Base64 expansion plus a bounded JSON envelope, not a decoder output allowance.
export const PROCESS_PROTOCOL_BYTES =
  Math.ceil(MEDIA_MAX_OUTPUT_BYTES / 3) * 4 + 8192;
export type ProcessingFailureCode =
  | 'MEDIA_PROCESSOR_UNAVAILABLE'
  | 'MEDIA_PROCESSOR_BUSY'
  | 'MEDIA_PROCESSING_TIMEOUT'
  | 'MEDIA_INPUT_REJECTED'
  | 'MEDIA_OUTPUT_REJECTED'
  | 'MEDIA_PROCESSING_FAILED';
export class MediaProcessingError extends Error {
  constructor(readonly code: ProcessingFailureCode) {
    super(code);
    this.name = 'MediaProcessingError';
  }
}
export const imageMeasurementSchema = z
  .strictObject({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    mime: mediaMimeSchema,
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
  })
  .refine((image) => image.width * image.height <= MEDIA_MAX_PIXELS);
const outputSchema = imageMeasurementSchema.safeExtend({
  data: z
    .string()
    .max(Math.ceil(MEDIA_MAX_INPUT_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export const workerResultSchema = z.strictObject({
  original: imageMeasurementSchema,
  variants: z.tuple([
    outputSchema.safeExtend({ name: z.literal('thumb-v1') }),
    outputSchema.safeExtend({ name: z.literal('display-v1') }),
  ]),
});
export type ImageMeasurement = z.infer<typeof imageMeasurementSchema>;
export interface ProcessedVariant extends ImageMeasurement {
  readonly name: 'thumb-v1' | 'display-v1';
  readonly data: Buffer;
}
export interface ProcessedImage {
  readonly original: ImageMeasurement;
  readonly variants: readonly [ProcessedVariant, ProcessedVariant];
}
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Neither metadata nor a child-process exit code alone proves actual output bytes. */
export function parseWorkerResult(
  encoded: Buffer,
  source: { bytes: number; sha256: string; mime: string },
): ProcessedImage {
  if (encoded.length > PROCESS_PROTOCOL_BYTES)
    throw new MediaProcessingError('MEDIA_OUTPUT_REJECTED');
  const parsed = workerResultSchema.safeParse(
    JSON.parse(encoded.toString('utf8')) as unknown,
  );
  if (!parsed.success) throw new MediaProcessingError('MEDIA_OUTPUT_REJECTED');
  const result = parsed.data;
  if (
    result.original.bytes !== source.bytes ||
    result.original.sha256 !== source.sha256 ||
    result.original.mime !== source.mime
  )
    throw new MediaProcessingError('MEDIA_OUTPUT_REJECTED');
  const variants = result.variants.map((variant) => {
    const data = Buffer.from(variant.data, 'base64');
    const maximum = variant.name === 'thumb-v1' ? 400 : 2048;
    if (
      data.toString('base64') !== variant.data ||
      data.length !== variant.bytes ||
      sha256(data) !== variant.sha256 ||
      variant.mime !== result.original.mime ||
      Math.max(variant.width, variant.height) > maximum ||
      Math.max(variant.width, variant.height) >
        Math.max(result.original.width, result.original.height) ||
      variant.width * variant.height >
        result.original.width * result.original.height
    )
      throw new MediaProcessingError('MEDIA_OUTPUT_REJECTED');
    return { ...variant, data };
  });
  if (
    variants.reduce((total, variant) => total + variant.bytes, 0) >
    MEDIA_MAX_OUTPUT_BYTES
  )
    throw new MediaProcessingError('MEDIA_OUTPUT_REJECTED');
  return { original: result.original, variants: [variants[0]!, variants[1]!] };
}
