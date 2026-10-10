import type { Readable } from 'node:stream';
import type { z } from 'zod';
import type { mediaIntentStatusSchema, MediaVariantName } from './contracts.js';
export const MEDIA_APPLICATION = Symbol('MEDIA_APPLICATION');
export type MediaIntentStatus = z.infer<typeof mediaIntentStatusSchema>;
export interface MediaApplication {
  prepare(token: string, input: unknown): Promise<MediaIntentStatus>;
  status(token: string, intentId: string): Promise<MediaIntentStatus>;
  finalize(token: string, intentId: string): Promise<MediaIntentStatus>;
  cancel(token: string, intentId: string): Promise<void>;
  open(
    token: string,
    bindingId: string,
    variant: MediaVariantName,
    range?: string,
  ): Promise<{
    stream: Readable;
    headers: Readonly<Record<string, string>>;
    abort(): void;
  }>;
}
