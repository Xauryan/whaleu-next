import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaDigestSchema } from './contracts.js';
import { mediaV2IdSchema } from './contracts-v2.js';

export interface CategoryIconRetirementRequest {
  readonly requestId: string;
  readonly appearanceIds: readonly string[];
}
const appearanceSchema = z.strictObject({
  appearanceId: mediaV2IdSchema,
  assetId: mediaV2IdSchema,
  bindingId: mediaV2IdSchema,
  actorAccountId: mediaV2IdSchema,
  manifestDigest: mediaDigestSchema,
});
export type CategoryIconTerminalAppearance = z.infer<typeof appearanceSchema>;
export interface AuthorizedCategoryIconRetirement {
  readonly actorAccountId: string;
  readonly requestId: string;
  readonly closureRevision: string;
  readonly kind: 'terminal-no-recoverable-roots';
  readonly appearances: readonly CategoryIconTerminalAppearance[];
}
/** Only the original Category owner implements this port. It locks and verifies
 * the complete base/override (including removed, dormant and archived) recovery
 * roots, unresolved sources and prepared/delivery/worker holds BEFORE Media
 * mutation locks. A pure retirement candidate list is not an authorization.
 * The owner enrolls the exact closure in its mandatory final proof. */
export interface CategoryIconRetirementOwnerPort {
  authorizeTerminalRetirement(
    credential: string,
    request: CategoryIconRetirementRequest,
    tx: PoolClient,
  ): Promise<AuthorizedCategoryIconRetirement>;
}
const brand: unique symbol = Symbol('category-icon-terminal-retirement');
export interface CategoryIconTerminalRetirement {
  readonly [brand]: true;
}
export class CategoryIconRetirementProofRegistry {
  private readonly proofs = new WeakMap<
    CategoryIconTerminalRetirement,
    {
      tx: PoolClient;
      epoch: object;
      authority: AuthorizedCategoryIconRetirement;
      claimed: boolean;
    }
  >();
  constructor(private readonly owner: CategoryIconRetirementOwnerPort) {}
  async authorize(
    credential: string,
    request: CategoryIconRetirementRequest,
    tx: PoolClient,
  ): Promise<CategoryIconTerminalRetirement> {
    const epoch = transactionReadEpoch(tx);
    if (
      !epoch ||
      !credential ||
      request.appearanceIds.length > 256 ||
      new Set(request.appearanceIds).size !== request.appearanceIds.length
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(request.requestId);
    const appearanceIds = request.appearanceIds
      .map((id) => mediaV2IdSchema.parse(id))
      .sort();
    const authority = await this.owner.authorizeTerminalRetirement(
      credential,
      Object.freeze({
        requestId: request.requestId,
        appearanceIds: Object.freeze(appearanceIds),
      }),
      tx,
    );
    mediaV2IdSchema.parse(authority.actorAccountId);
    mediaDigestSchema.parse(authority.closureRevision);
    const appearances = authority.appearances
      .map((value) => Object.freeze(appearanceSchema.parse(value)))
      .sort((a, b) => a.appearanceId.localeCompare(b.appearanceId));
    if (
      authority.kind !== 'terminal-no-recoverable-roots' ||
      authority.requestId !== request.requestId ||
      transactionReadEpoch(tx) !== epoch ||
      new Set(appearances.map((a) => a.assetId)).size !== appearances.length ||
      new Set(appearances.map((a) => a.bindingId)).size !==
        appearances.length ||
      JSON.stringify(appearances.map((a) => a.appearanceId)) !==
        JSON.stringify(appearanceIds)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const proof: CategoryIconTerminalRetirement = Object.freeze({
      [brand]: true as const,
    });
    this.proofs.set(proof, {
      tx,
      epoch,
      claimed: false,
      authority: Object.freeze({
        ...authority,
        appearances: Object.freeze(appearances),
      }),
    });
    return proof;
  }
  /** Single-use admission into a bulk mutation in the same transaction epoch. */
  claim(
    proof: CategoryIconTerminalRetirement,
    actor: string,
    tx: PoolClient,
  ): AuthorizedCategoryIconRetirement {
    const facts = this.proofs.get(proof);
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== transactionReadEpoch(tx) ||
      facts.claimed ||
      facts.authority.actorAccountId !== actor
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    facts.claimed = true;
    return facts.authority;
  }
}
