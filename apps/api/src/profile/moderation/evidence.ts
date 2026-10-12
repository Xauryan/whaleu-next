import { createHash, randomInt } from 'node:crypto';
import { canonicalJson } from '../../community/content-review/contracts.js';
import type { ModerationCommand } from './contracts.js';
export const moderationIntentHash = (
  actor: string,
  command: ModerationCommand,
): string =>
  createHash('sha256')
    .update(
      'whaleu:profile-moderation-command:v1\n' +
        canonicalJson({ actor, command }),
    )
    .digest('hex');
/** Called only for a previously unrecorded, authorized, non-stale request. The
 * chosen output is stored atomically and is never regenerated during recovery. */
export function violationNickname(): string {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return (
    '违规昵称' +
    Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(
      '',
    )
  );
}
