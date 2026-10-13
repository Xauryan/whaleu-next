import { createHash } from 'node:crypto';
import { canonicalJson } from '../content-review/contracts.js';
import type { AdminPostRemovalCommand } from './contracts.js';

/** This command cannot be replayed as a profile, jury or author-delete command. */
export const adminPostRemovalIntentHash = (
  actor: string,
  command: AdminPostRemovalCommand,
): string =>
  createHash('sha256')
    .update(
      `whaleu:admin-post-removal-command:v${'version' in command ? 2 : 1}\n` +
        canonicalJson({ actor, command }),
    )
    .digest('hex');
