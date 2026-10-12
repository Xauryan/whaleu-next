import { createHash } from 'node:crypto';
import { canonicalJson } from '../../community/content-review/contracts.js';
import type { AvatarModerationCommand } from './contracts.js';

/** This command cannot be replayed as a nickname or self-selection command. */
export const avatarModerationIntentHash = (
  actor: string,
  command: AvatarModerationCommand,
): string =>
  createHash('sha256')
    .update(
      'whaleu:profile-avatar-moderation-command:v1\n' +
        canonicalJson({ actor, command }),
    )
    .digest('hex');
