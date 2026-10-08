import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  ErrandContacts,
  ErrandOperation,
  ErrandsQuery,
  PublishErrand,
} from './contracts.js';
import type { ErrandContentEnvelope } from '../community/content-review/errand-contracts.js';
export interface ErrandRow {
  id: string;
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
  return {
    version: 1,
    accountId: row.publisher_id,
    purpose: 'publish_errand',
    title: row.title,
    publicText: row.public_text,
    privateText: row.private_text,
    expectedTimeText: row.expected_time_text,
    reward: row.reward,
    publisherContacts: row.publisher_contacts,
    publicAssetIds: [],
    privateAssetIds: [],
    scope: row.scope,
  };
}
@Injectable()
export class ErrandsRepository {
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
    return { ...row, ...privateRow };
  }
  async create(
    actor: string,
    body: PublishErrand,
    scope: ErrandContentEnvelope['scope'],
    tx: PoolClient,
  ) {
    const id = randomUUID(),
      revision = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_errands.orders(id,revision,publisher_id,target_region_id,source_region_id,scope,title,public_text,expected_time_text,reward,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
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
