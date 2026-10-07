import { z } from 'zod';
import type { RuntimeConfig } from '../config/config.js';
export const workerOptionsSchema = z.strictObject({
  mode: z.enum(['dry-run', 'apply']).default('dry-run'),
  eventIds: z
    .array(z.uuid().transform((id) => id.toLowerCase()))
    .max(50)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length),
});
export type WorkerOptions = z.infer<typeof workerOptionsSchema>;
export function assertLocalUpdatesWorker(config: RuntimeConfig) {
  if (
    config.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(
      new URL(config.DATABASE_URL).hostname,
    )
  )
    throw new Error('Updates worker is local-only');
}
export function parseUpdatesCommand(args: readonly string[]): WorkerOptions {
  let mode: WorkerOptions['mode'] = 'dry-run';
  const pending = [...args];
  if (pending[0] === 'dry-run' || pending[0] === 'apply')
    mode = pending.shift() as WorkerOptions['mode'];
  const eventIds: string[] = [];
  for (const arg of pending) {
    const match = /^--event-id=(.+)$/.exec(arg);
    if (!match) throw new Error('Invalid updates worker arguments');
    eventIds.push(match[1]!);
  }
  if (mode === 'apply' && !eventIds.length)
    throw new Error('Apply requires explicitly selected events');
  return workerOptionsSchema.parse({ mode, eventIds });
}
