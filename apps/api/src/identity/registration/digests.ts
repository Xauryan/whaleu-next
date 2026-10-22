import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ProviderIdentity } from '../contracts.js';
import { ApplicationError } from '../../http/application-error.js';

export const REGISTRATION_GUARD_PROTOCOL = 'provider-registration-guard-v1';
export const MAXIMUM_DIGEST_EPOCHS = 8;
export const keyEpochSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const keyRingSchema = z.strictObject({
  version: z.literal(1),
  activeEpoch: keyEpochSchema,
  keys: z
    .array(
      z.strictObject({
        epoch: keyEpochSchema,
        keyHex: z.string().regex(/^[a-fA-F0-9]{64}$/),
      }),
    )
    .min(1)
    .max(MAXIMUM_DIGEST_EPOCHS),
});
export type DigestKeyRing = z.infer<typeof keyRingSchema>;
export interface IdentityDigest {
  readonly epoch: string;
  readonly digest: string;
}
/** Parse an externally provisioned secret. Diagnostics deliberately exclude the
 * input, parser cause and values. Shape checks are not an entropy attestation. */
export function parseDigestKeyRing(value: string): DigestKeyRing {
  try {
    if (value.length > 8192) throw new Error();
    const ring = keyRingSchema.parse(JSON.parse(value));
    const epochs = new Set(ring.keys.map((key) => key.epoch));
    const values = new Set(ring.keys.map((key) => key.keyHex.toLowerCase()));
    if (
      epochs.size !== ring.keys.length ||
      values.size !== ring.keys.length ||
      !epochs.has(ring.activeEpoch)
    )
      throw new Error();
    return Object.freeze({
      ...ring,
      keys: Object.freeze(
        ring.keys.map((key) =>
          Object.freeze({ ...key, keyHex: key.keyHex.toLowerCase() }),
        ),
      ),
    }) as DigestKeyRing;
  } catch {
    throw new Error(
      'Invalid configuration field: IDENTITY_DELETION_DIGEST_KEYRING',
    );
  }
}
/** Server-only HMAC, never a public hash of a low-entropy/provider identifier.
 * unionSubject is deliberately excluded: no cross-app account merging. */
export class ProviderIdentityDigests {
  readonly activeEpoch: string;
  readonly epochs: readonly string[];
  readonly #keys: ReadonlyMap<string, Buffer>;
  constructor(ring: DigestKeyRing) {
    // Validate even programmatic configuration, not just environment parsing.
    const checked = parseDigestKeyRing(JSON.stringify(ring));
    this.activeEpoch = checked.activeEpoch;
    this.epochs = Object.freeze(checked.keys.map((key) => key.epoch).sort());
    this.#keys = new Map(
      checked.keys.map((key) => [key.epoch, Buffer.from(key.keyHex, 'hex')]),
    );
  }
  private hmac(epoch: string, fields: readonly string[]): string {
    const key = this.#keys.get(epoch);
    if (!key) throw new ApplicationError('AUTH_NOT_CONFIGURED');
    return createHmac('sha256', key)
      .update(JSON.stringify(fields))
      .digest('hex');
  }
  keyCheck(epoch: string): string {
    return this.hmac(epoch, [REGISTRATION_GUARD_PROTOCOL, 'key-check', epoch]);
  }
  matchesKeyCheck(epoch: string, expected: string): boolean {
    return (
      /^[a-f0-9]{64}$/.test(expected) &&
      this.#keys.has(epoch) &&
      timingSafeEqual(
        Buffer.from(this.keyCheck(epoch), 'hex'),
        Buffer.from(expected, 'hex'),
      )
    );
  }
  digest(identity: ProviderIdentity, epoch: string): IdentityDigest {
    if (
      identity.provider !== 'wechat' ||
      !/^wx[a-f0-9]{16}$/.test(identity.appId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(identity.subject)
    )
      throw new ApplicationError('AUTH_NOT_CONFIGURED');
    return Object.freeze({
      epoch,
      digest: this.hmac(epoch, [
        REGISTRATION_GUARD_PROTOCOL,
        'provider-identity',
        epoch,
        identity.provider,
        identity.appId,
        identity.subject,
      ]),
    });
  }
}
