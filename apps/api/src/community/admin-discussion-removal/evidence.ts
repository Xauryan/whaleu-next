import { createHash } from 'node:crypto';
import { canonicalJson } from '../content-review/contracts.js';
import type { AdminDiscussionRemovalCommand } from './contracts.js';

/** This command cannot be replayed as a profile, jury or author-delete command. */
export const adminDiscussionRemovalIntentHash = (
  actor: string,
  command: AdminDiscussionRemovalCommand,
): string =>
  createHash('sha256')
    .update(
      `whaleu:admin-discussion-removal-command:v${'version' in command ? command.version : 1}\n` +
        canonicalJson({ actor, command }),
    )
    .digest('hex');
