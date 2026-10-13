import { createHash } from 'node:crypto';
import { canonicalJson } from '../../community/content-review/contracts.js';
import type {
  AppealSubmitCommand,
  AppealDecisionCommand,
} from '../account-moderation/contracts.js';
export function appealIntentHash(
  actor: string,
  command: AppealSubmitCommand | AppealDecisionCommand,
): string {
  return createHash('sha256')
    .update(
      'whaleu:account-appeal-command:v1\n' + canonicalJson({ actor, command }),
    )
    .digest('hex');
}
/** Plain private evidence. Reject transport control characters and bidi controls;
 * keep newlines and tabs, and do not reinterpret text as HTML or Markdown. */
export function safeAppealText(text: string): boolean {
  return !Array.from(text).some((character) => {
    const code = character.codePointAt(0)!;
    return (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
}
