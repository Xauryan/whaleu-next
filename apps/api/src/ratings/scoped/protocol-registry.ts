import { createHash } from 'node:crypto';
import { canonicalJson } from '../../community/content-review/contracts.js';

/** Request and domain operations are different closed unions, never suffixes. */
export const ratingScopedProtocolRegistry = {
  set_score_scoped: { domain: 'set_score', purpose: null, effect: null },
  create_comment_scoped: {
    domain: 'create_comment',
    purpose: 'publish_rating_comment_scoped',
    effect: 'root_created',
  },
  create_reply_scoped: {
    domain: 'create_reply',
    purpose: 'publish_rating_reply_scoped',
    effect: 'reply_created',
  },
  set_comment_like_scoped: {
    domain: 'set_comment_like',
    purpose: null,
    effect: 'content_liked',
  },
  set_reply_like_scoped: {
    domain: 'set_reply_like',
    purpose: null,
    effect: 'content_liked',
  },
  set_target_subscription_scoped: {
    domain: 'set_target_subscription',
    purpose: null,
    effect: 'target_subscribed',
  },
  create_target_scoped: {
    domain: 'create_target',
    purpose: 'publish_rating_target_scoped',
    effect: null,
  },
  edit_target_scoped: {
    domain: 'edit_target',
    purpose: 'edit_rating_target_scoped',
    effect: null,
  },
} as const;
export type RatingScopedOperation = keyof typeof ratingScopedProtocolRegistry;
export const ratingScopedOperations = Object.freeze(
  Object.keys(ratingScopedProtocolRegistry) as RatingScopedOperation[],
);
export function ratingScopedCommandHash(value: {
  protocolVersion: 2;
  operation: RatingScopedOperation;
  context: unknown;
  payload: unknown;
}): string {
  return createHash('sha256')
    .update(
      'whaleu:rating-scoped-command:v1\n' +
        canonicalJson({
          protocolVersion: value.protocolVersion,
          operation: value.operation,
          intent: { context: value.context, payload: value.payload },
        }),
    )
    .digest('hex');
}
export function ratingScopedDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`whaleu:rating-scoped-${domain}:v1\n${canonicalJson(value)}`)
    .digest('hex');
}
