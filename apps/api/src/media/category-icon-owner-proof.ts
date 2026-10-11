import { z } from 'zod';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaDigestSchema } from './contracts.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { categoryIconMediaParentSchema } from './contracts-category-icon.js';
import type { CategoryIconMediaParent } from './contracts-category-icon.js';

export interface CategoryIconMediaPrincipal {
  readonly kind: 'authenticatedRatings';
  readonly accountId: string;
  readonly sessionId: string;
}
export interface CategoryIconMediaReadRequest {
  readonly categoryId: string;
  readonly contextId: string;
  readonly contextToken: string;
  readonly appearanceId: string;
  readonly purpose:
    'list-projection' | 'direct-content' | 'download' | 'management-preview';
  /** Server-generated per-request identity, never a viewer/account substitute. */
  readonly requestId: string;
}
/** Frozen public wire shape. A management-root credential may never stand in
 * for the original current release and complete public path qualification. */
export const categoryIconMediaReleaseQualificationSchema = z.strictObject({
  releaseId: mediaV2IdSchema,
  catalogId: mediaV2IdSchema,
  effectiveRevision: mediaV2IdSchema,
  identityId: mediaV2IdSchema,
  baseSource: z.strictObject({
    id: mediaV2IdSchema,
    revision: mediaV2IdSchema,
  }),
  overrideSource: z
    .strictObject({ id: mediaV2IdSchema, revision: mediaV2IdSchema })
    .nullable(),
  definitionId: mediaV2IdSchema,
  extensionDigest: mediaDigestSchema,
});
export const categoryIconMediaManagementQualificationSchema = z.strictObject({
  kind: z.literal('management-root'),
  rootDefinitionId: mediaV2IdSchema,
  closureRevision: mediaDigestSchema,
  identityId: mediaV2IdSchema,
  baseSource: z.strictObject({
    id: mediaV2IdSchema,
    revision: mediaV2IdSchema,
  }),
  overrideSource: z
    .strictObject({ id: mediaV2IdSchema, revision: mediaV2IdSchema })
    .nullable(),
  definitionId: mediaV2IdSchema,
  definitionDigest: mediaDigestSchema,
});
export const categoryIconMediaQualificationSchema = z.union([
  categoryIconMediaReleaseQualificationSchema,
  categoryIconMediaManagementQualificationSchema,
]);
export type CategoryIconMediaManagementQualification = z.infer<
  typeof categoryIconMediaManagementQualificationSchema
>;
export type CategoryIconMediaQualification = z.infer<
  typeof categoryIconMediaQualificationSchema
>;
export interface AuthorizedCategoryIconMediaRead {
  readonly principal: CategoryIconMediaPrincipal;
  readonly actorAccountId: string;
  readonly categoryId: string;
  readonly parent: CategoryIconMediaParent;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly bindingId: string;
  readonly ownerRevision: string;
  readonly reviewRevision: string;
  readonly qualification: CategoryIconMediaQualification;
}
/** DI-only authenticated Ratings owner. Revalidate session/Safety, exact
 * scope, current definition, appearance and exact Ratings Review and
 * enroll the mandatory owner proof in this same transaction. */
export interface CategoryIconMediaReadPort {
  authorizeCurrent(
    credential: string,
    request: CategoryIconMediaReadRequest,
    tx: PoolClient,
  ): Promise<AuthorizedCategoryIconMediaRead>;
}
const brand: unique symbol = Symbol('category-icon-media-read-proof');
export interface CategoryIconMediaReadProof {
  readonly [brand]: true;
}
interface Facts {
  tx: PoolClient;
  epoch: object;
  request: CategoryIconMediaReadRequest;
  authority: AuthorizedCategoryIconMediaRead;
}
export class CategoryIconMediaProofRegistry {
  private readonly issued = new WeakMap<CategoryIconMediaReadProof, Facts>();
  constructor(private readonly owner: CategoryIconMediaReadPort) {}
  async authorize(
    credential: string,
    request: CategoryIconMediaReadRequest,
    tx: PoolClient,
  ): Promise<CategoryIconMediaReadProof> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !credential) throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(request.categoryId);
    mediaV2IdSchema.parse(request.contextId);
    if (!/^[A-Za-z0-9_-]{43}$/.test(request.contextToken))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(request.appearanceId);
    mediaV2IdSchema.parse(request.requestId);
    if (
      ![
        'list-projection',
        'direct-content',
        'download',
        'management-preview',
      ].includes(request.purpose)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot = Object.freeze({ ...request });
    const read = await this.owner.authorizeCurrent(credential, snapshot, tx);
    const parent = categoryIconMediaParentSchema.parse(read.parent);
    const qualification = categoryIconMediaQualificationSchema.parse(
      read.qualification,
    );
    if (
      (request.purpose === 'management-preview') !==
      ('kind' in qualification && qualification.kind === 'management-root')
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    Object.freeze(qualification.baseSource);
    if (qualification.overrideSource)
      Object.freeze(qualification.overrideSource);
    Object.freeze(qualification);
    mediaV2IdSchema.parse(read.actorAccountId);
    mediaV2IdSchema.parse(read.assetId);
    mediaV2IdSchema.parse(read.bindingId);
    mediaDigestSchema.parse(read.manifestDigest);
    mediaDigestSchema.parse(read.ownerRevision);
    mediaDigestSchema.parse(read.reviewRevision);
    if (
      read.categoryId !== request.categoryId ||
      parent.resourceId !== request.appearanceId ||
      transactionReadEpoch(tx) !== epoch
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (read.principal.kind !== 'authenticatedRatings')
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(read.principal.accountId);
    mediaV2IdSchema.parse(read.principal.sessionId);
    const proof: CategoryIconMediaReadProof = Object.freeze({
      [brand]: true as const,
    });
    this.issued.set(proof, {
      tx,
      epoch,
      request: snapshot,
      authority: Object.freeze({
        ...read,
        parent: Object.freeze(parent),
        qualification,
        principal: Object.freeze({ ...read.principal }),
      }),
    });
    return proof;
  }
  require(
    proof: CategoryIconMediaReadProof,
    request: CategoryIconMediaReadRequest,
    tx: PoolClient,
  ): AuthorizedCategoryIconMediaRead {
    const facts = this.issued.get(proof);
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== transactionReadEpoch(tx) ||
      facts.request.categoryId !== request.categoryId ||
      facts.request.contextId !== request.contextId ||
      facts.request.contextToken !== request.contextToken ||
      facts.request.appearanceId !== request.appearanceId ||
      facts.request.requestId !== request.requestId ||
      facts.request.purpose !== request.purpose
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return facts.authority;
  }
}
