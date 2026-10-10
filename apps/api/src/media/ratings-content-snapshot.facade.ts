import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { mediaDigestSchema, mediaIdSchema } from './contracts.js';
import { ratingsMediaParentSchema as mediaParentSchema } from './contracts-ratings.js';
import type { RatingsMediaParent as MediaParent } from './contracts-ratings.js';
import { validateCurrentMedia } from './current-facts.js';

/** A structural budget port avoids Media depending on Ratings. The caller
 * shares the SAME owner 64 MiB allowance with all other batch metadata. */
export interface MediaSnapshotReadBudget {
  rows<T>(
    read: PoolClient,
    sql: string,
    values: unknown[],
    cap: number,
    dates?: readonly string[],
  ): Promise<T[]>;
}
export interface RatingsMediaContentReference {
  readonly parent: MediaParent;
  readonly expected: readonly { assetId: string; digest: string }[];
}
export interface RatingsMediaContentAttachment {
  readonly slot: 'cover';
  readonly ordinal: number;
  readonly bindingId: string;
  readonly assetId: string;
  readonly manifestDigest: string;
  /** Display dimensions from the digest-verified canonical manifest. */
  readonly width: number;
  readonly height: number;
  readonly policyRevision: string;
  readonly intentId: string;
  readonly intentState: 'ready';
  readonly headRevision: string;
  readonly eventId: string;
}
export interface RatingsMediaContentFact {
  readonly version: 6;
  readonly parent: MediaParent;
  readonly decision: 'allow' | 'deny' | 'unknown';
  readonly validUntil: number | null;
  readonly attachments: readonly RatingsMediaContentAttachment[];
}
export const ratingsMediaContentKey = (parent: MediaParent): string =>
  JSON.stringify([
    parent.ownerKind,
    parent.resourceKind,
    parent.resourceId,
    parent.contentVersion,
  ]);

interface SnapshotRow {
  parent_id: string;
  parent_kind: string;
  binding_id: string | null;
  asset_id: string | null;
  binding_digest: string | null;
  ordinal: number | null;
  slot: string | null;
  id: string | null;
  intent_id: string | null;
  audience: string | null;
  purpose: string | null;
  owner_kind: string | null;
  resource_kind: string | null;
  content_version: string | null;
  manifest_digest: string | null;
  manifest: unknown;
  policy_revision: string | null;
  intent_state: string | null;
  protocol_version: number | null;
  target_kind: string | null;
  head_revision: string | null;
  event_id: string | null;
  state: string | null;
  event_digest: string | null;
  event_policy: string | null;
  effective_at: Date | null;
  valid_until: Date | null;
  read_at: Date;
  exact_time_valid: boolean;
}

/** Conditional metadata only: no row locks, mandatory proof enrollment, object
 * bytes, storage/provider calls, URLs, or transaction deadlines. The owner proof
 * covering this read is the consumer's responsibility, including negative facts. */
export class RatingsMediaContentSnapshotFacade {
  async readBatch(
    references: readonly RatingsMediaContentReference[],
    read: PoolClient,
    budget: MediaSnapshotReadBudget,
  ): Promise<ReadonlyMap<string, RatingsMediaContentFact>> {
    if (references.length > 256)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const result = new Map<string, RatingsMediaContentFact>();
    const requested = new Map<string, RatingsMediaContentReference>();
    const expectedByKey = new Map<string, string>();
    const unknown = (parent: MediaParent): RatingsMediaContentFact =>
      Object.freeze({
        version: 6,
        parent: Object.freeze({ ...parent }),
        decision: 'unknown',
        validUntil: null,
        attachments: Object.freeze([]),
      });
    for (const reference of references) {
      const { parent, expected } = reference;
      const key = ratingsMediaContentKey(parent);
      const encoded = JSON.stringify(expected);
      if (expectedByKey.has(key)) {
        if (expectedByKey.get(key) !== encoded) {
          requested.delete(key);
          result.set(key, unknown(parent));
        }
        continue;
      }
      expectedByKey.set(key, encoded);
      result.set(key, unknown(parent));
      if (
        !mediaParentSchema.safeParse(parent).success ||
        parent.ownerKind !== 'ratings'
      )
        continue;
      // Null cover belongs to the owner definition and has no appearance reference.
      // An existing immutable appearance can never be treated as an empty set.
      if (
        parent.resourceKind !== 'target_cover' ||
        expected.length !== 1 ||
        new Set(expected.map((image) => image.assetId)).size !==
          expected.length ||
        expected.some(
          (image) =>
            !mediaIdSchema.safeParse(image.assetId).success ||
            !mediaDigestSchema.safeParse(image.digest).success,
        )
      )
        continue;
      requested.set(
        key,
        Object.freeze({
          parent: Object.freeze({ ...parent }),
          expected: Object.freeze(
            expected.map((image) => Object.freeze({ ...image })),
          ),
        }),
      );
    }
    if (requested.size > 256) throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (!requested.size) return result;
    const ids = [...requested.values()].map(({ parent }) => parent.resourceId);
    const kinds = [...requested.values()].map(
      ({ parent }) => parent.resourceKind,
    );
    const rows = await budget.rows<SnapshotRow>(
      read,
      `SELECT p.id AS parent_id,p.kind AS parent_kind,b.id AS binding_id,b.asset_id,b.manifest_digest AS binding_digest,b.ordinal,b.slot,
       a.id,a.intent_id,a.audience,a.purpose,a.owner_kind,a.resource_kind,a.content_version::text,
       a.manifest_digest,a.manifest,a.policy_revision,i.state AS intent_state,i.protocol_version,a.target_kind,
       h.revision::text AS head_revision,h.event_id,e.state,e.manifest_digest AS event_digest,
       e.policy_revision AS event_policy,e.effective_at,e.valid_until,t.read_at,
       COALESCE(e.effective_at<=t.read_at AND e.valid_until>t.read_at AND e.valid_until>e.effective_at,false) AS exact_time_valid
       FROM unnest($1::uuid[],$2::text[]) p(id,kind)
       CROSS JOIN (SELECT clock_timestamp() AS read_at) t
       LEFT JOIN whaleu_media.bindings b ON b.owner_kind='ratings' AND b.resource_kind=p.kind
         AND b.resource_id=p.id AND b.content_version=1 AND b.detached_at IS NULL
       LEFT JOIN whaleu_media.assets a ON a.id=b.asset_id
       LEFT JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
       LEFT JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id
       LEFT JOIN whaleu_media.asset_safety_events e ON e.asset_id=a.id AND e.revision=h.revision AND e.id=h.event_id
       ORDER BY p.kind,p.id,b.ordinal,b.id`,
      [ids, kinds],
      [...requested.values()].reduce(
        (sum, reference) => sum + reference.expected.length,
        0,
      ),
      ['effective_at', 'valid_until', 'read_at'],
    );
    const grouped = new Map<string, SnapshotRow[]>();
    for (const row of rows) {
      const group =
        grouped.get(JSON.stringify([row.parent_kind, row.parent_id])) ?? [];
      group.push(row);
      grouped.set(JSON.stringify([row.parent_kind, row.parent_id]), group);
    }
    for (const [key, reference] of requested) {
      const records = grouped.get(
        JSON.stringify([
          reference.parent.resourceKind,
          reference.parent.resourceId,
        ]),
      );
      if (
        !records ||
        records.length !== reference.expected.length ||
        new Set(records.map((row) => row.binding_id)).size !== records.length
      )
        continue;
      const attachments: RatingsMediaContentAttachment[] = [];
      let decision: 'allow' | 'deny' | 'unknown' = 'allow';
      let validUntil = Number.POSITIVE_INFINITY;
      for (const [ordinal, row] of records.entries()) {
        const expected = reference.expected[ordinal]!;
        if (
          !row.binding_id ||
          !row.id ||
          !row.intent_id ||
          !row.event_id ||
          !row.head_revision ||
          !/^[1-9][0-9]*$/.test(row.head_revision) ||
          row.asset_id !== expected.assetId ||
          row.id !== expected.assetId ||
          row.binding_digest !== expected.digest ||
          row.manifest_digest !== expected.digest ||
          row.ordinal !== ordinal ||
          row.slot !== 'cover' ||
          row.audience !== 'content-gated' ||
          row.purpose !== 'ratings-target-cover-image' ||
          row.owner_kind !== 'ratings' ||
          row.resource_kind !== reference.parent.resourceKind ||
          row.content_version !== '1' ||
          row.protocol_version !== 6 ||
          row.target_kind !== 'edit' ||
          !row.policy_revision ||
          !row.effective_at ||
          !row.valid_until
        ) {
          decision = 'unknown';
          break;
        }
        const checked = validateCurrentMedia(
          {
            manifest: row.manifest,
            manifest_digest: row.manifest_digest,
            policy_revision: row.policy_revision,
          },
          row.intent_state ?? undefined,
          {
            state: row.state ?? '',
            manifest_digest: row.event_digest ?? '',
            policy_revision: row.event_policy ?? '',
            effective_at: row.effective_at,
            valid_until: row.valid_until,
          },
          row.read_at.getTime(),
          row.exact_time_valid,
        );
        if (checked.decision === 'unknown') {
          decision = 'unknown';
          break;
        }
        if (checked.decision === 'deny') decision = 'deny';
        validUntil = Math.min(validUntil, checked.validUntil);
        attachments.push(
          Object.freeze({
            slot: 'cover',
            ordinal,
            bindingId: row.binding_id,
            assetId: row.id,
            manifestDigest: row.manifest_digest,
            width: checked.manifest.variants[1].width,
            height: checked.manifest.variants[1].height,
            policyRevision: row.policy_revision,
            intentId: row.intent_id,
            intentState: 'ready',
            headRevision: row.head_revision,
            eventId: row.event_id,
          }),
        );
      }
      if (
        decision === 'unknown' ||
        attachments.length !== reference.expected.length
      )
        continue;
      result.set(
        key,
        Object.freeze({
          version: 6,
          parent: Object.freeze({ ...reference.parent }),
          decision,
          validUntil,
          attachments: Object.freeze(attachments),
        }),
      );
    }
    return result;
  }
}

/** Disabled by default: deployment must install an explicit trusted runtime. */
export class UnavailableRatingsMediaContentSnapshotFacade extends RatingsMediaContentSnapshotFacade {
  override async readBatch(
    references: readonly RatingsMediaContentReference[],
    _read: PoolClient,
    _budget: MediaSnapshotReadBudget,
  ): Promise<ReadonlyMap<string, RatingsMediaContentFact>> {
    if (references.length > 256)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return new Map(
      references.map(({ parent }) => [
        ratingsMediaContentKey(parent),
        Object.freeze({
          version: 6 as const,
          parent: Object.freeze({ ...parent }),
          decision: 'unknown' as const,
          validUntil: null,
          attachments: Object.freeze([]),
        }),
      ]),
    );
  }
}
