import { Inject, Injectable } from '@nestjs/common';
import { homeDistributionCandidateSql } from '../home-distribution/candidate-sql.js';
import {
  homeDistributionAllowed,
  prepareHomeDistribution,
} from '../home-distribution/read-proof.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { CampusCommunityPolicyService } from '../../campus/community-policy/campus-community-policy.service.js';
import { RegionalCommunityPolicyService } from '../../campus/community-policy/regional-community-policy.service.js';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import type { Authority, Decision } from '../community-policy.js';
import type {
  AuthorMode,
  Category,
  CommunitySpace,
  Capabilities,
} from '../contracts.js';
import {
  canonicalJson,
  canonicalEnvelope,
} from '../content-review/contracts.js';
import type {
  AcceptedApproval,
  EffectiveContentEnvelope,
} from '../content-review/contracts.js';
import {
  legacyContentScopeSchema,
  relatedRootScopeSchema,
  inheritedRelatedScopeSchema,
} from '../content-review/scope-contracts.js';
import type {
  ContentScopeSnapshot,
  RelatedRootScope,
  InheritedRelatedScope,
  LegacyContentScope,
} from '../content-review/scope-contracts.js';
import { readDistributionBindings } from './binding.js';
import { relatedOrdinaryCategories } from './contracts.js';
import type {
  CommunityDistributionScope,
  DistributionPostReference,
  RelatedCampusDisplay,
  RelatedPublicationContext,
  RelatedPublicationShape,
} from './contracts.js';

const hash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export const publicationMembersDigest = (members: readonly string[]) =>
  createHash('sha256')
    .update('whaleu-related-publication-members:v1\n')
    .update(
      canonicalJson(
        [...new Set(members.map((member) => member.toLowerCase()))].sort(),
      ),
    )
    .digest('hex');
interface Policy {
  id: string;
  operating_region_id: string;
  categories: string[];
  author_modes: string[];
  component_kinds: string[];
  images_allowed: boolean;
  anonymous_dm_allowed: boolean;
  valid_until_exact: string | null;
}
interface AdmissionFact {
  kind: 'root' | 'enable' | 'observation' | 'view';
  actor: string | null;
  region: string;
  scope: RelatedRootScope | null;
  fingerprint: string;
}
const admissionProof: RequiredTransactionProof<AdmissionFact> = {
  maximumFacts: 64,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      for (const fact of facts) {
        if (fact.kind === 'observation')
          await read.query(
            'SELECT whaleu_community.related_sync_observation_assert($1)',
            [fact.fingerprint],
          );
        else if (fact.kind === 'view')
          await read.query(
            'SELECT whaleu_community.related_sync_view_assert($1)',
            [fact.fingerprint],
          );
        else if (fact.kind === 'enable')
          await read.query(
            'SELECT whaleu_community.related_sync_enable_assert($1,$2)',
            [fact.region, fact.fingerprint],
          );
        else
          await read.query(
            'SELECT whaleu_community.related_sync_root_admission_assert($1,$2::jsonb,$3)',
            [fact.actor, JSON.stringify(fact.scope), fact.fingerprint],
          );
      }
    }),
};
interface ViewPrivate {
  tx: PoolClient;
  epoch: object;
  spaces: Map<string, CommunitySpace>;
  regionNames: Map<string, string>;
}
const views = new WeakMap<CommunityDistributionScope, ViewPrivate>();
@Injectable()
export class CommunityDistributionService {
  constructor(
    @Inject(CampusCommunityPolicyService)
    private readonly campuses: CampusCommunityPolicyService,
    @Inject(RegionalCommunityPolicyService)
    private readonly policies: RegionalCommunityPolicyService,
  ) {}
  async observeRootAdmission(tx: PoolClient): Promise<void> {
    const row = (
      await tx.query<{ fingerprint: string }>(
        'SELECT whaleu_community.related_sync_observation() AS fingerprint',
      )
    ).rows[0];
    if (!row?.fingerprint) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    enableRequiredTransactionProof(tx, admissionProof);
    const fact: AdmissionFact = Object.freeze({
      kind: 'observation',
      actor: null,
      region: '',
      scope: null,
      fingerprint: row.fingerprint,
    });
    registerRequiredTransactionFact(
      tx,
      admissionProof,
      canonicalJson(fact),
      fact,
    );
  }
  private async policy(region: string, tx: PoolClient): Promise<Policy> {
    const row = (
      await tx.query<Policy>(
        `SELECT p.*,p.valid_until::text AS valid_until_exact
      FROM whaleu_community.related_sync_policy_heads h JOIN whaleu_community.related_sync_policies p
      ON p.id=h.policy_id AND p.operating_region_id=h.operating_region_id AND p.version=h.revision
      WHERE h.operating_region_id=$1 AND whaleu_community.related_sync_policy_current(p.id)
      FOR SHARE OF h`,
        [region],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    registerTransactionExactDeadline(
      tx,
      row.valid_until_exact,
      'COMMUNITY_UNAVAILABLE',
    );
    return row;
  }
  private async retain(
    fact: Omit<AdmissionFact, 'fingerprint'>,
    tx: PoolClient,
  ): Promise<void> {
    const row = (
      await tx.query<{ fingerprint: string }>(
        fact.kind === 'enable'
          ? 'SELECT whaleu_community.related_sync_enable_fingerprint($1) AS fingerprint'
          : 'SELECT whaleu_community.related_sync_root_admission_fingerprint($1,$2::jsonb) AS fingerprint',
        fact.kind === 'enable'
          ? [fact.region]
          : [fact.actor, JSON.stringify(fact.scope)],
      )
    ).rows[0];
    if (!row?.fingerprint) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    enableRequiredTransactionProof(tx, admissionProof);
    const retained = Object.freeze({ ...fact, fingerprint: row.fingerprint });
    registerRequiredTransactionFact(
      tx,
      admissionProof,
      canonicalJson(retained),
      retained,
    );
  }
  async requirePolicyEnable(regionId: string, tx: PoolClient): Promise<void> {
    await this.retain(
      { kind: 'enable', actor: null, region: regionId, scope: null },
      tx,
    );
    const group = await this.campuses.distributionGroup(regionId, tx);
    if (group.status !== 'known' || group.memberRegionIds.length < 2)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    await this.policy(regionId, tx);
  }
  async capability(
    actor: string,
    space: CommunitySpace,
    category: Category,
    authority: Authority,
    tx: PoolClient,
  ): Promise<NonNullable<Capabilities['relatedCampusSync']>> {
    void actor;
    if (
      !space.operatingRegionId ||
      space.kind !== 'regional' ||
      !(relatedOrdinaryCategories as readonly string[]).includes(category)
    )
      return { availability: 'denied', reason: 'COMMUNITY_SCOPE_UNAVAILABLE' };
    if (
      !authority.phoneVerified ||
      !authority.studentVerified ||
      authority.publicationScope?.identityRegionId !== space.operatingRegionId
    )
      return {
        availability: 'denied',
        reason: 'STUDENT_VERIFICATION_REQUIRED',
      };
    try {
      const config = await this.policies.resolve(space.operatingRegionId, tx);
      if (config.status !== 'known')
        return { availability: 'unavailable', reason: 'COMMUNITY_UNAVAILABLE' };
      if (!config.relatedSyncEnabled)
        return {
          availability: 'denied',
          reason: 'COMMUNITY_ACTION_RESTRICTED',
        };
      const group = await this.campuses.distributionGroup(
        space.operatingRegionId,
        tx,
      );
      if (group.status !== 'known')
        return { availability: 'unavailable', reason: 'COMMUNITY_UNAVAILABLE' };
      if (group.memberRegionIds.length < 2)
        return {
          availability: 'denied',
          reason: 'COMMUNITY_SCOPE_UNAVAILABLE',
        };
      const policy = await this.policy(space.operatingRegionId, tx);
      return policy.categories.includes(category)
        ? {
            availability: 'allowed',
            reason: null,
            authorModes: policy.author_modes.filter(
              (mode): mode is AuthorMode =>
                mode === 'named' || mode === 'anonymous',
            ),
            canDisableComments:
              authority.canDisableComments ?? authority.canManage,
          }
        : { availability: 'denied', reason: 'COMMUNITY_SCOPE_UNAVAILABLE' };
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      return { availability: 'unavailable', reason: 'COMMUNITY_UNAVAILABLE' };
    }
  }
  async prepare(
    actor: string,
    space: CommunitySpace,
    shape: RelatedPublicationShape,
    authority: Authority,
    tx: PoolClient,
  ): Promise<RelatedRootScope> {
    await this.observeRootAdmission(tx);
    const base = legacyContentScopeSchema.safeParse(authority.publicationScope);
    if (
      !base.success ||
      !space.isActive ||
      space.kind !== 'regional' ||
      !space.operatingRegionId ||
      !authority.phoneVerified ||
      !authority.studentVerified ||
      authority.identityStatus !== 'valid' ||
      base.data.identityRegionId !== space.operatingRegionId
    )
      throw new ApplicationError('COMMUNITY_ACTION_RESTRICTED');
    const group = await this.campuses.distributionGroup(
      space.operatingRegionId,
      tx,
    );
    if (
      group.status !== 'known' ||
      group.memberRegionIds.length < 2 ||
      group.topologySnapshotId !== base.data.topologySnapshotId
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const config = await this.policies.resolve(space.operatingRegionId, tx);
    if (config.status !== 'known')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (!config.relatedSyncEnabled)
      throw new ApplicationError('COMMUNITY_ACTION_RESTRICTED');
    const policy = await this.policy(space.operatingRegionId, tx);
    if (
      !policy.categories.includes(shape.category) ||
      !policy.author_modes.includes(shape.authorMode) ||
      !policy.component_kinds.includes(shape.componentKind) ||
      (shape.imageCount > 0 && !policy.images_allowed) ||
      (shape.allowAnonymousDm === true && !policy.anonymous_dm_allowed)
    )
      throw new ApplicationError('COMMUNITY_ACTION_RESTRICTED');
    const scope = relatedRootScopeSchema.parse({
      ...base.data,
      sync: 'related',
      configurationRevisionId: config.revisionId,
      syncPolicyId: policy.id,
      publicationGroupId: group.groupId,
      publicationMembersDigest: publicationMembersDigest(group.memberRegionIds),
    });
    await this.retain(
      { kind: 'root', actor, region: space.operatingRegionId, scope },
      tx,
    );
    return Object.freeze(scope);
  }
  async requireEnvelopeShape(
    input: EffectiveContentEnvelope,
    tx: PoolClient,
  ): Promise<void> {
    const envelope = canonicalEnvelope(input);
    if (envelope.version !== 4) return;
    const row = (
      await tx.query<{ allowed: boolean }>(
        'SELECT whaleu_community.related_sync_envelope_admitted($1::jsonb) AS allowed',
        [JSON.stringify(envelope)],
      )
    ).rows[0];
    if (!row?.allowed) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (envelope.scope.sync === 'related')
      await this.retain(
        {
          kind: 'root',
          actor: envelope.accountId,
          region: envelope.scope.originalRegionId,
          scope: envelope.scope,
        },
        tx,
      );
  }
  async bind(
    postId: string,
    context: RelatedPublicationContext,
    approval: AcceptedApproval,
    tx: PoolClient,
  ): Promise<void> {
    if (
      approval.envelope.version !== 4 ||
      approval.envelope.scope.sync !== 'related'
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await this.requireEnvelopeShape(approval.envelope, tx);
    const scope = approval.envelope.scope;
    await tx.query(
      `INSERT INTO whaleu_community.post_distribution_bindings
      (post_id,original_space_id,original_region_id,topology_snapshot_id,publication_group_id,publication_members,
       publication_members_digest,sync_policy_id,scope,decision_id,digest,account_id,client_request_id,intent_hash)
      SELECT $1,$2,$3,$4,$5,ARRAY(SELECT jsonb_array_elements_text(g->'memberRegionIds')::uuid),$6,$7,$8::jsonb,$9,$10,$11,$12,$13
      FROM (SELECT whaleu_campus.community_distribution_group($3) g) source`,
      [
        postId,
        scope.originalSpaceId,
        scope.originalRegionId,
        scope.topologySnapshotId,
        scope.publicationGroupId,
        scope.publicationMembersDigest,
        scope.syncPolicyId,
        JSON.stringify(scope),
        approval.decisionId,
        approval.digest,
        approval.envelope.accountId,
        context.clientRequestId,
        context.intentHash,
      ],
    );
  }
  async inherit(
    postId: string,
    childScope: ContentScopeSnapshot,
    tx: PoolClient,
  ): Promise<InheritedRelatedScope | LegacyContentScope> {
    const post = (
      await tx.query<{ publication_envelope_version: number }>(
        'SELECT publication_envelope_version FROM whaleu_community.posts WHERE id=$1',
        [postId],
      )
    ).rows[0];
    if (!post) throw new ApplicationError('POST_NOT_FOUND');
    const base = legacyContentScopeSchema.parse(childScope);
    if (post.publication_envelope_version !== 4) return base;
    const binding = (await readDistributionBindings([postId], tx)).get(postId);
    if (
      !binding?.valid ||
      base.originalSpaceId !== binding.scope.originalSpaceId ||
      base.originalRegionId !== binding.scope.originalRegionId
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return inheritedRelatedScopeSchema.parse({
      ...base,
      sync: 'inherited_related',
      parentDistribution: {
        postId,
        decisionId: binding.decisionId,
        digest: binding.digest,
      },
    });
  }
  private owned(
    scope: CommunityDistributionScope,
    tx?: PoolClient,
  ): ViewPrivate {
    const value = views.get(scope);
    if (
      !value ||
      (tx && value.tx !== tx) ||
      transactionReadEpoch(value.tx) !== value.epoch
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return value;
  }
  async resolveView(
    space: CommunitySpace,
    tx: PoolClient,
  ): Promise<CommunityDistributionScope> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !space.isActive)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (space.kind === 'global') {
      const scope: CommunityDistributionScope = Object.freeze({
        viewSpaceId: space.id,
        viewRegionId: null,
        relatedCampusDistribution: 'complete',
        fingerprint: hash({ view: space.id, kind: 'global' }),
        originalSpaceIds: Object.freeze([space.id]),
        remoteSpaceIds: Object.freeze([]),
      });
      views.set(scope, {
        tx,
        epoch,
        spaces: new Map([[space.id, space]]),
        regionNames: new Map(),
      });
      return scope;
    }
    const viewGeneration = (
      await tx.query<{ generation: string }>(
        "SELECT whaleu_community.related_sync_generation_fingerprint('view') AS generation",
      )
    ).rows[0]?.generation;
    if (!viewGeneration) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    enableRequiredTransactionProof(tx, admissionProof);
    const viewFact: AdmissionFact = Object.freeze({
      kind: 'view',
      actor: null,
      region: '',
      scope: null,
      fingerprint: viewGeneration,
    });
    registerRequiredTransactionFact(
      tx,
      admissionProof,
      canonicalJson(viewFact),
      viewFact,
    );
    const group = space.operatingRegionId
      ? await this.campuses.distributionGroup(space.operatingRegionId, tx)
      : null;
    const spaces = new Map<string, CommunitySpace>([[space.id, space]]);
    const regionNames = new Map<string, string>();
    if (group?.status === 'known') {
      for (let i = 0; i < group.memberRegionIds.length; i += 256) {
        const rows = (
          await tx.query<CommunitySpace & { regionName: string }>(
            `SELECT s.id,s.kind,s.name,s.is_active AS "isActive",s.operating_region_id AS "operatingRegionId",r.name AS "regionName"
          FROM whaleu_community.spaces s JOIN whaleu_campus.operating_regions r ON r.id=s.operating_region_id
          WHERE s.kind='regional' AND s.operating_region_id=ANY($1::uuid[]) AND s.is_active AND r.is_active ORDER BY s.id FOR SHARE OF s,r`,
            [group.memberRegionIds.slice(i, i + 256)],
          )
        ).rows;
        for (const row of rows) {
          spaces.set(row.id, row);
          regionNames.set(row.operatingRegionId!, row.regionName);
        }
      }
    }
    const scope: CommunityDistributionScope = Object.freeze({
      viewSpaceId: space.id,
      viewRegionId: space.operatingRegionId,
      relatedCampusDistribution:
        group?.status === 'unavailable' ? 'unavailable' : 'complete',
      fingerprint: hash({
        view: space.id,
        viewGeneration,
        group: group?.fingerprint ?? null,
        spaces: [...spaces.values()].map((s) => [
          s.id,
          s.operatingRegionId,
          s.isActive,
          s.name,
        ]),
      }),
      originalSpaceIds: Object.freeze([...spaces.keys()].sort()),
      remoteSpaceIds: Object.freeze(
        [...spaces.keys()].filter((id) => id !== space.id).sort(),
      ),
    });
    views.set(scope, { tx, epoch, spaces, regionNames });
    return scope;
  }
  sqlPredicate(
    scope: CommunityDistributionScope,
    alias: string,
    categoryColumn: 'category' | 'current_category',
    parameters: unknown[],
  ): string {
    this.owned(scope);
    void categoryColumn;
    if (!/^[a-z][a-z0-9_]*$/.test(alias))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    parameters.push(scope.viewSpaceId);
    const local = parameters.length;
    if (!scope.remoteSpaceIds.length)
      return `(${alias}.space_id=$${local}::uuid)`;
    parameters.push([...scope.remoteSpaceIds]);
    const remote = parameters.length;
    // Keep malformed native roots in the structural window, so the owner can
    // report unknown rather than silently certify a complete corpus without them.
    return `(${alias}.space_id=$${local}::uuid OR (${alias}.space_id=ANY($${remote}::uuid[]) AND ${homeDistributionCandidateSql(alias, null, 'related_sync', parameters)} AND (${alias}.publication_envelope_version=4 OR EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings ds WHERE ds.post_id=${alias}.id))))`;
  }
  display(
    scope: CommunityDistributionScope,
    originalSpace: CommunitySpace,
  ): RelatedCampusDisplay {
    const view = this.owned(scope);
    if (originalSpace.id === scope.viewSpaceId)
      return { isRelatedCampusSync: false };
    const name =
      originalSpace.operatingRegionId &&
      view.regionNames.get(originalSpace.operatingRegionId);
    if (!name || !scope.remoteSpaceIds.includes(originalSpace.id))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return {
      isRelatedCampusSync: true,
      sourceRegion: { id: originalSpace.operatingRegionId!, name },
    };
  }
  async allows(
    scope: CommunityDistributionScope,
    postId: string,
    originalSpaceId: string,
    category: Category,
    tx: PoolClient,
  ): Promise<Decision<RelatedCampusDisplay>> {
    return (
      await this.evaluatePosts(
        scope,
        [{ id: postId, space_id: originalSpaceId, category }],
        tx,
      )
    ).get(postId)!;
  }
  async evaluatePosts(
    scope: CommunityDistributionScope,
    posts: readonly DistributionPostReference[],
    tx: PoolClient,
  ): Promise<Map<string, Decision<RelatedCampusDisplay>>> {
    const view = this.owned(scope, tx);
    if (posts.length > 256) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const remote = posts.filter(
      (p) =>
        p.space_id !== scope.viewSpaceId &&
        scope.remoteSpaceIds.includes(p.space_id),
    );
    const bindings = await readDistributionBindings(
      remote.map((p) => p.id),
      tx,
    );
    const roots = remote.length
      ? (
          await tx.query<{ id: string; publication_envelope_version: number }>(
            'SELECT id,publication_envelope_version FROM whaleu_community.posts WHERE id=ANY($1::uuid[])',
            [remote.map((p) => p.id)],
          )
        ).rows
      : [];
    const versions = new Map(
      roots.map((p) => [p.id, p.publication_envelope_version]),
    );
    // Canonical versions, never the reference supplied by a caller. Local reads
    // (including search/detail) retain their own access semantics. Only actual
    // remote distribution consumes this immutable Home suppression proof.
    await prepareHomeDistribution(
      roots
        .filter((post) => post.publication_envelope_version === 7)
        .map((post) => post.id),
      tx,
    );
    const result = new Map<string, Decision<RelatedCampusDisplay>>();
    for (const post of posts) {
      if (post.space_id === scope.viewSpaceId) {
        result.set(post.id, {
          kind: 'allow',
          value: { isRelatedCampusSync: false },
        });
        continue;
      }
      if (
        versions.get(post.id) === 7 &&
        !(await homeDistributionAllowed(post.id, null, 'related_sync', tx))
      ) {
        result.set(post.id, { kind: 'deny', reason: 'POST_NOT_FOUND' });
        continue;
      }
      if (scope.relatedCampusDistribution === 'unavailable') {
        result.set(post.id, { kind: 'unavailable' });
        continue;
      }
      if (!scope.remoteSpaceIds.includes(post.space_id)) {
        result.set(post.id, { kind: 'deny', reason: 'POST_NOT_FOUND' });
        continue;
      }
      const binding = bindings.get(post.id);
      if (!binding && versions.has(post.id) && versions.get(post.id)! < 4) {
        result.set(post.id, { kind: 'deny', reason: 'POST_NOT_FOUND' });
        continue;
      }
      if (!binding?.valid || binding.scope.originalSpaceId !== post.space_id) {
        result.set(post.id, { kind: 'unavailable' });
        continue;
      }
      if (binding.category !== post.category) {
        result.set(post.id, { kind: 'unavailable' });
        continue;
      }
      if (
        !(relatedOrdinaryCategories as readonly string[]).includes(
          post.category,
        )
      ) {
        result.set(post.id, { kind: 'deny', reason: 'POST_NOT_FOUND' });
        continue;
      }
      const original = view.spaces.get(post.space_id);
      if (!original) {
        result.set(post.id, { kind: 'unavailable' });
        continue;
      }
      result.set(post.id, {
        kind: 'allow',
        value: this.display(scope, original),
      });
    }
    return result;
  }
}
