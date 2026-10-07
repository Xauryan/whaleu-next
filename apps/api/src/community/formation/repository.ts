import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  FormationComponent,
  FormationContacts,
  OwnFormationMembership,
} from './contracts.js';
export interface StoredFormation {
  id: string;
  post_id: string;
  capacity: number;
  theme: string;
  reconciliation: 'current' | 'unreconciled';
}
export interface StoredFormationMember {
  id: string;
  formation_id: string;
  account_id: string;
  is_creator: boolean;
  joined_at: Date;
  seat: number;
  contact_sharing: 'members_v1' | 'legacy_unconfirmed';
}
@Injectable()
export class FormationRepository {
  async create(
    postId: string,
    actor: string,
    input: FormationComponent,
    tx: PoolClient,
  ) {
    const id = randomUUID();
    await tx.query(
      'INSERT INTO whaleu_community.formations(id,post_id,capacity,theme) VALUES($1,$2,$3,$4)',
      [id, postId, input.capacity, input.theme],
    );
    await this.addMember(
      id,
      actor,
      true,
      input.contacts,
      input.contactSharing,
      tx,
    );
  }
  async find(
    postId: string,
    tx: PoolClient,
    write = false,
  ): Promise<StoredFormation | null> {
    return (
      (
        await tx.query<StoredFormation>(
          `SELECT id,post_id,capacity,theme,reconciliation FROM whaleu_community.formations WHERE post_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
          [postId],
        )
      ).rows[0] ?? null
    );
  }
  async members(id: string, tx: PoolClient): Promise<StoredFormationMember[]> {
    // Contact columns deliberately excluded from every ordinary projection.
    return (
      await tx.query<StoredFormationMember>(
        'SELECT id,formation_id,account_id,is_creator,joined_at,seat,contact_sharing FROM whaleu_community.formation_members WHERE formation_id=$1 ORDER BY is_creator DESC,joined_at,seat FOR SHARE',
        [id],
      )
    ).rows;
  }
  async addMember(
    id: string,
    actor: string,
    creator: boolean,
    contacts: FormationContacts,
    consent: 'members_v1',
    tx: PoolClient,
  ) {
    const result = await tx.query<{ id: string; joined_at: Date }>(
      'INSERT INTO whaleu_community.formation_members(id,formation_id,account_id,is_creator,wechat,qq,phone,contact_sharing) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,joined_at',
      [
        randomUUID(),
        id,
        actor,
        creator,
        contacts.wechat,
        contacts.qq,
        contacts.phone,
        consent,
      ],
    );
    return {
      resourceId: result.rows[0]!.id,
      createdAt: result.rows[0]!.joined_at.toISOString(),
    };
  }
  async own(
    actor: string,
    postId: string,
    tx: PoolClient,
  ): Promise<OwnFormationMembership | null> {
    const row = (
      await tx.query<{
        post_id: string;
        id: string;
        joined_at: Date;
        is_creator: boolean;
      }>(
        'SELECT f.post_id,m.id,m.joined_at,m.is_creator FROM whaleu_community.formation_members m JOIN whaleu_community.formations f ON f.id=m.formation_id WHERE m.account_id=$1 AND f.post_id=$2',
        [actor, postId],
      )
    ).rows[0];
    return row
      ? {
          postId: row.post_id,
          membershipId: row.id,
          joinedAt: row.joined_at.toISOString(),
          isCreator: row.is_creator,
        }
      : null;
  }
  async contacts(memberId: string, tx: PoolClient): Promise<FormationContacts> {
    return (
      await tx.query<FormationContacts>(
        'SELECT wechat,qq,phone FROM whaleu_community.formation_members WHERE id=$1',
        [memberId],
      )
    ).rows[0]!;
  }
}
