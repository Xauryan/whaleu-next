import { ApplicationError } from '../http/application-error.js';
import { Inject, Injectable } from '@nestjs/common';
import { ErrandGroupEnrollment } from '../notifications/errand-group/enrollment.js';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  ErrandContacts,
  ErrandOperation,
  ErrandsQuery,
  PublishErrand,
} from './contracts.js';
import type { ErrandImageBinding } from './publication-contracts.js';
import { errandImageBindingSchema } from './publication-contracts.js';
import type { ErrandContentEnvelope } from '../community/content-review/errand-contracts.js';
export interface ErrandRow {
  id: string;
  publication_version?: number;
  revision: string;
  publisher_id: string;
  accepter_id: string | null;
  target_region_id: string;
  source_region_id: string;
  scope: ErrandContentEnvelope['scope'];
  title: string;
  public_text: string;
  private_text: string;
  expected_time_text: string;
  reward: string;
  publisher_contacts: ErrandContacts;
  accepter_contacts: ErrandContacts | null;
  state: 'pending' | 'accepted' | 'completed' | 'cancelled';
  created_at: Date;
  accepted_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  deleted_at: Date | null;
  media?: {
    draftId: string;
    draftRevision: number;
    revision: number;
    publicMedia: ErrandImageBinding[];
    privateMedia: ErrandImageBinding[];
  };
}
export interface ErrandSeek {
  id: string;
  createdAt: string;
  reward: string;
}
export interface ErrandListPosition {
  v: 1;
  anchor: string;
  since: string | null;
  validUntil: number;
  after: ErrandSeek | null;
}
export function errandEnvelope(row: ErrandRow): ErrandContentEnvelope {
  const base = {
    accountId: row.publisher_id,
    purpose: 'publish_errand',
    title: row.title,
    publicText: row.public_text,
    privateText: row.private_text,
    expectedTimeText: row.expected_time_text,
    reward: row.reward,
    publisherContacts: row.publisher_contacts,
    scope: row.scope,
  };
  if (!row.media)
    return {
      ...base,
      purpose: 'publish_errand',
      version: 1,
      publicAssetIds: [],
      privateAssetIds: [],
    };
  const facts = (items: ErrandImageBinding[]) =>
    items.map(({ bindingId: _binding, ...fact }) => {
      void _binding;
      return fact;
    });
  return {
    ...base,
    purpose: 'publish_errand',
    version: 2,
    draftId: row.media.draftId,
    draftRevision: row.media.draftRevision,
    mediaRevision: row.media.revision,
    publicMedia: facts(row.media.publicMedia),
    privateMedia: facts(row.media.privateMedia),
  };
}
@Injectable()
export class ErrandsRepository {
  constructor(
    @Inject(ErrandGroupEnrollment)
    private readonly groups: ErrandGroupEnrollment,
  ) {}
  async read(
    id: string,
    tx: PoolClient,
    write = false,
  ): Promise<ErrandRow | null> {
    // One explicit domain row lock precedes the private projection. Lifecycle
    // authority cannot change after this point, including across cursor waits.
    const row = (
      await tx.query<
        Omit<
          ErrandRow,
          'private_text' | 'publisher_contacts' | 'accepter_contacts'
        >
      >(
        `SELECT * FROM whaleu_errands.orders WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [id],
      )
    ).rows[0];
    if (!row) return null;
    const privateRow = (
      await tx.query<
        Pick<
          ErrandRow,
          'private_text' | 'publisher_contacts' | 'accepter_contacts'
        >
      >(
        'SELECT private_text,publisher_contacts,accepter_contacts FROM whaleu_errands.private_details WHERE order_id=$1',
        [id],
      )
    ).rows[0];
    if (!privateRow) throw new Error('Missing errand private definition');
    // This optional owner table exists only in the current schema. Older
    // historical migration harnesses still exercise unchanged v1 lifecycle.
    const installed = (
      await tx.query<{ installed: boolean }>(
        "SELECT to_regclass('whaleu_errands.media_publications') IS NOT NULL installed",
      )
    ).rows[0]?.installed;
    if (!installed) return { ...row, ...privateRow };
    const media = (
      await tx.query<{
        draft_id: string;
        draft_revision: string;
        revision: string;
        public_media: unknown;
        private_media: unknown;
      }>(
        'SELECT p.draft_id,p.draft_revision,h.revision,s.public_media,s.private_media FROM whaleu_errands.media_publications p JOIN whaleu_errands.media_heads h ON h.order_id=p.order_id JOIN whaleu_errands.media_sets s ON (s.order_id,s.revision)=(h.order_id,h.revision) WHERE p.order_id=$1',
        [id],
      )
    ).rows[0];
    if (!media) {
      if (row.publication_version === 2)
        throw new ApplicationError('ERRAND_UNAVAILABLE');
      return { ...row, ...privateRow };
    }
    return {
      ...row,
      ...privateRow,
      media: {
        draftId: media.draft_id,
        draftRevision: Number(media.draft_revision),
        revision: Number(media.revision),
        publicMedia: errandImageBindingSchema
          .array()
          .max(3)
          .parse(media.public_media),
        privateMedia: errandImageBindingSchema
          .array()
          .max(3)
          .parse(media.private_media),
      },
    };
  }
  async create(
    actor: string,
    body: PublishErrand,
    scope: ErrandContentEnvelope['scope'],
    tx: PoolClient,
    orderId?: string,
    publicationVersion: 1 | 2 = 1,
  ) {
    const id = orderId ?? randomUUID(),
      revision = randomUUID();
    await tx.query(
      publicationVersion === 1
        ? `INSERT INTO whaleu_errands.orders(id,revision,publisher_id,target_region_id,source_region_id,scope,title,public_text,expected_time_text,reward,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`
        : `INSERT INTO whaleu_errands.orders(id,revision,publisher_id,target_region_id,source_region_id,scope,title,public_text,expected_time_text,reward,state,publication_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',2)`,
      [
        id,
        revision,
        actor,
        scope.targetRegionId,
        scope.sourceRegionId,
        JSON.stringify(scope),
        body.title,
        body.publicText,
        body.expectedTimeText,
        body.reward,
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_errands.private_details(order_id,private_text,publisher_contacts) VALUES($1,$2,$3)',
      [id, body.privateText, JSON.stringify(body.publisherContacts)],
    );
    return (await this.read(id, tx, true))!;
  }
  async transition(
    row: ErrandRow,
    actor: string,
    operation: Exclude<ErrandOperation, 'publish'>,
    contacts: ErrandContacts | null,
    tx: PoolClient,
  ) {
    const revision = randomUUID();
    if (operation === 'delete')
      await tx.query(
        "UPDATE whaleu_errands.orders SET revision=$2,deleted_at=date_trunc('milliseconds',clock_timestamp()),deleted_by=$3 WHERE id=$1",
        [row.id, revision, actor],
      );
    else if (operation === 'accept') {
      await tx.query(
        "UPDATE whaleu_errands.orders SET revision=$2,state='accepted',accepter_id=$3,accepted_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
        [row.id, revision, actor],
      );
      await tx.query(
        'UPDATE whaleu_errands.private_details SET accepter_contacts=$2 WHERE order_id=$1',
        [row.id, JSON.stringify(contacts)],
      );
    } else if (operation === 'cancel')
      await tx.query(
        "UPDATE whaleu_errands.orders SET revision=$2,state='cancelled',cancelled_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
        [row.id, revision],
      );
    else
      await tx.query(
        "UPDATE whaleu_errands.orders SET revision=$2,state='completed',completed_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
        [row.id, revision],
      );
    return (await this.read(row.id, tx, true))!;
  }
  async event(
    row: ErrandRow,
    actor: string,
    operation: ErrandOperation,
    prior: ErrandRow['state'] | null,
    requestId: string,
    tx: PoolClient,
  ) {
    const id = randomUUID();
    const occurredAt = (
      await tx.query<{ occurred_at: Date }>(
        'INSERT INTO whaleu_errands.transitions(id,order_id,actor_id,operation,prior_state,next_state,revision,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING occurred_at',
        [
          id,
          row.id,
          actor,
          operation,
          prior,
          row.state,
          row.revision,
          requestId,
        ],
      )
    ).rows[0]!.occurred_at.toISOString();
    if (operation === 'publish')
      await this.groups.record(
        id,
        row.id,
        row.target_region_id,
        row.created_at.toISOString(),
        tx,
      );
    return { id, occurredAt };
  }
  async remember(
    accountId: string,
    contacts: ErrandContacts,
    transitionId: string,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_errands.contact_history(account_id,contacts,transition_id) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET contacts=EXCLUDED.contacts,transition_id=EXCLUDED.transition_id,updated_at=clock_timestamp()',
      [accountId, JSON.stringify(contacts), transitionId],
    );
  }
  async contacts(accountId: string, tx: PoolClient) {
    return (
      (
        await tx.query<{ contacts: ErrandContacts }>(
          'SELECT contacts FROM whaleu_errands.contact_history WHERE account_id=$1 FOR SHARE',
          [accountId],
        )
      ).rows[0]?.contacts ?? null
    );
  }
  async candidates(
    actor: string,
    position: ErrandListPosition,
    mode:
      | { kind: 'discovery'; query: ErrandsQuery; ownOnly: boolean }
      | { kind: 'own'; relation: 'published' | 'accepted' },
    tx: PoolClient,
  ) {
    const params: unknown[] = [position.anchor];
    const bind = (value: unknown) => {
      params.push(value);
      return '$' + params.length;
    };
    const filters = ['deleted_at IS NULL', 'created_at<=$1::timestamptz'];
    let sort: 'created' | 'reward' = 'created',
      direction: 'asc' | 'desc' = 'desc';
    if (mode.kind === 'discovery') {
      filters.push(`target_region_id=${bind(mode.query.regionId)}`);
      filters.push(`created_at>=${bind(position.since)}::timestamptz`);
      filters.push(
        mode.query.filter === 'pending'
          ? "state='pending'"
          : "state IN ('pending','accepted')",
      );
      if (mode.ownOnly) filters.push(`publisher_id=${bind(actor)}`);
      sort = mode.query.sort;
      direction = mode.query.direction;
    } else
      filters.push(
        `${mode.relation === 'published' ? 'publisher_id' : 'accepter_id'}=${bind(actor)}`,
      );
    const compare = direction === 'asc' ? '>' : '<',
      order = direction === 'asc' ? 'ASC' : 'DESC';
    if (position.after) {
      const a = position.after;
      filters.push(
        sort === 'reward'
          ? `(reward,created_at,id) ${compare} (${bind(a.reward)}::numeric,${bind(a.createdAt)}::timestamptz,${bind(a.id)}::uuid)`
          : `(created_at,id) ${compare} (${bind(a.createdAt)}::timestamptz,${bind(a.id)}::uuid)`,
      );
    }
    return (
      await tx.query<{ id: string }>(
        `SELECT id FROM whaleu_errands.orders WHERE ${filters.join(' AND ')} ORDER BY ${sort === 'reward' ? `reward ${order},` : ''}created_at ${order},id ${order} LIMIT 101`,
        params,
      )
    ).rows;
  }
}
