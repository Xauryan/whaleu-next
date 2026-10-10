import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  mediaDigestSchema,
  mediaIdSchema,
  mediaParentSchema,
} from './contracts.js';
import type { MediaParent } from './contracts.js';
import { validateCurrentMedia } from './current-facts.js';

/** A structural budget port avoids Media depending on Community. The caller
 * shares the SAME 4 MiB allowance with all other batch metadata. */
export interface MediaSnapshotReadBudget {
  rows<T>(
    read: PoolClient,
    sql: string,
    values: unknown[],
    cap: number,
    dates?: readonly string[],
  ): Promise<T[]>;
}
export interface MediaContentReference {
  readonly parent: MediaParent;
  readonly expected: readonly { assetId: string; digest: string }[];
}
export interface MediaContentAttachment {
  readonly slot: 'images';
  readonly ordinal: number;
  readonly bindingId: string;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly policyRevision: string;
  readonly intentId: string;
  readonly intentState: 'ready';
  readonly headRevision: string;
  readonly eventId: string;
}
export interface MediaContentFact {
  readonly version: 1;
  readonly parent: MediaParent;
  readonly decision: 'allow' | 'deny' | 'unknown';
  readonly validUntil: number | null;
  readonly attachments: readonly MediaContentAttachment[];
}
export const mediaContentKey = (parent: MediaParent): string =>
  JSON.stringify([
    parent.ownerKind,
    parent.resourceKind,
    parent.resourceId,
    parent.contentVersion,
  ]);

interface SnapshotRow {
  parent_id: string;
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
export class MediaContentSnapshotFacade {
  async readBatch(
    references: readonly MediaContentReference[],
    read: PoolClient,
    budget: MediaSnapshotReadBudget,
  ): Promise<ReadonlyMap<string, MediaContentFact>> {
    if (references.length > 768)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const result = new Map<string, MediaContentFact>();
    const requested = new Map<string, MediaContentReference>();
    const expectedByKey = new Map<string, string>();
    const unknown = (parent: MediaParent): MediaContentFact =>
      Object.freeze({
        version: 1,
        parent: Object.freeze({ ...parent }),
        decision: 'unknown',
        validUntil: null,
        attachments: Object.freeze([]),
      });
    for (const reference of references) {
      const { parent, expected } = reference;
      const key = mediaContentKey(parent);
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
        parent.ownerKind !== 'community'
      )
        continue;
      // Empty attachments are an explicit owner definition, NOT an inference
      // from a missing Media row. Community's source proof covers that definition.
      if (expected.length === 0) {
        result.set(
          key,
          Object.freeze({
            version: 1,
            parent: Object.freeze({ ...parent }),
            decision: 'allow',
            validUntil: null,
            attachments: Object.freeze([]),
          }),
        );
        continue;
      }
      if (
        parent.resourceKind !== 'post' ||
        expected.length !== 1 ||
        !mediaIdSchema.safeParse(expected[0]!.assetId).success ||
        !mediaDigestSchema.safeParse(expected[0]!.digest).success
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
    const rows = await budget.rows<SnapshotRow>(
      read,
      `SELECT p.id AS parent_id,b.id AS binding_id,b.asset_id,b.manifest_digest AS binding_digest,b.ordinal,b.slot,
       a.id,a.intent_id,a.audience,a.purpose,a.owner_kind,a.resource_kind,a.content_version::text,
       a.manifest_digest,a.manifest,a.policy_revision,i.state AS intent_state,
       h.revision::text AS head_revision,h.event_id,e.state,e.manifest_digest AS event_digest,
       e.policy_revision AS event_policy,e.effective_at,e.valid_until,t.read_at,
       COALESCE(e.effective_at<=t.read_at AND e.valid_until>t.read_at AND e.valid_until>e.effective_at,false) AS exact_time_valid
       FROM unnest($1::uuid[]) p(id)
       CROSS JOIN (SELECT clock_timestamp() AS read_at) t
       LEFT JOIN whaleu_media.bindings b ON b.owner_kind='community' AND b.resource_kind='post'
         AND b.resource_id=p.id AND b.content_version=1 AND b.detached_at IS NULL
       LEFT JOIN whaleu_media.assets a ON a.id=b.asset_id
       LEFT JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
       LEFT JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id
       LEFT JOIN whaleu_media.asset_safety_events e ON e.asset_id=a.id AND e.revision=h.revision AND e.id=h.event_id
       ORDER BY p.id,b.ordinal,b.id`,
      [ids],
      ids.length,
      ['effective_at', 'valid_until', 'read_at'],
    );
    const grouped = new Map<string, SnapshotRow[]>();
    for (const row of rows) {
      const group = grouped.get(row.parent_id) ?? [];
      group.push(row);
      grouped.set(row.parent_id, group);
    }
    for (const [key, reference] of requested) {
      const records = grouped.get(reference.parent.resourceId);
      if (records?.length !== 1) continue;
      const row = records[0]!,
        expected = reference.expected[0]!;
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
        row.ordinal !== 0 ||
        row.slot !== 'images' ||
        row.audience !== 'content-gated' ||
        row.purpose !== 'community-post-image' ||
        row.owner_kind !== 'community' ||
        row.resource_kind !== 'post' ||
        row.content_version !== '1' ||
        !row.policy_revision ||
        !row.effective_at ||
        !row.valid_until
      )
        continue;
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
      if (checked.decision === 'unknown') continue;
      result.set(
        key,
        Object.freeze({
          version: 1,
          parent: Object.freeze({ ...reference.parent }),
          decision: checked.decision,
          validUntil: checked.validUntil,
          attachments: Object.freeze([
            Object.freeze({
              slot: 'images' as const,
              ordinal: 0,
              bindingId: row.binding_id,
              assetId: row.id,
              manifestDigest: row.manifest_digest,
              policyRevision: row.policy_revision,
              intentId: row.intent_id,
              intentState: 'ready' as const,
              headRevision: row.head_revision,
              eventId: row.event_id,
            }),
          ]),
        }),
      );
    }
    return result;
  }
}

/** Ordinary AppModule stays disabled alongside CONTENT_MEDIA_PROOF. Only an
 * explicit synthetic/deployment DI installation may enable current Media facts. */
export class UnavailableMediaContentSnapshotFacade extends MediaContentSnapshotFacade {
  override async readBatch(
    references: readonly MediaContentReference[],
    read: PoolClient,
    budget: MediaSnapshotReadBudget,
  ): Promise<ReadonlyMap<string, MediaContentFact>> {
    if (references.some((reference) => reference.expected.length > 0))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return super.readBatch(references, read, budget);
  }
}
