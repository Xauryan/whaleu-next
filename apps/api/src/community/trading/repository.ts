import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { StoredPost } from '../community.repository.js';
import { actionAllowed } from '../community-policy.js';
import type { Authority } from '../community-policy.js';
import { canonicalPrice, tradingSubtypeSchema } from './contracts.js';
import type {
  TradingContacts,
  TradingInput,
  TradingView,
} from './contracts.js';
export interface StoredTrading {
  post_id: string;
  subtype: string;
  price: string | null;
  legacy_raw_price: string | null;
  legacy_raw_subtype: string | null;
  urgency: 'normal' | 'urgent';
  location: string;
  resolution: 'open' | 'resolved';
}
@Injectable()
export class TradingRepository {
  async create(
    postId: string,
    input: TradingInput,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_community.trading_listings
      (post_id,subtype,price,urgency,location,wechat,qq,phone) VALUES($1,$2,$3::numeric,$4,$5,$6,$7,$8)`,
      [
        postId,
        input.subtype,
        input.price,
        input.urgency,
        input.location,
        input.contacts.wechat,
        input.contacts.qq,
        input.contacts.phone,
      ],
    );
  }
  async find(
    postId: string,
    tx: PoolClient,
    write = false,
  ): Promise<StoredTrading | null> {
    const result = await tx.query<StoredTrading>(
      `SELECT post_id,subtype,price::text,legacy_raw_price,legacy_raw_subtype,urgency,location,resolution
      FROM whaleu_community.trading_listings WHERE post_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [postId],
    );
    return result.rows[0] ?? null;
  }
  async contacts(postId: string, tx: PoolClient): Promise<TradingContacts> {
    // Call only after the current visible parent is locked. Resolution changes
    // disclosure, never the immutable chosen values; owners have no exception.
    const row = (
      await tx.query<TradingContacts>(
        "SELECT wechat,qq,phone FROM whaleu_community.trading_listings WHERE post_id=$1 AND resolution='open' FOR SHARE",
        [postId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('POST_NOT_FOUND');
    return row;
  }
  async project(
    post: StoredPost,
    actor: string | null,
    authority: Authority | null,
    tx: PoolClient,
  ): Promise<TradingView | null> {
    if (post.category !== 'trading') return null;
    const row = await this.find(post.id, tx);
    const subtype = tradingSubtypeSchema.safeParse(row?.subtype);
    const price = row?.price ? canonicalPrice(row.price) : null;
    // Historical free text stays explicit and unparsed, separate from current writes.
    if (
      !row ||
      (!price && row.legacy_raw_price === null) ||
      post.author_mode !== 'named'
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return {
      subtype: subtype.success
        ? {
            kind: 'known',
            key: subtype.data,
            legacyText: row.legacy_raw_subtype,
          }
        : { kind: 'legacy', text: row.legacy_raw_subtype ?? row.subtype },
      price: price
        ? { kind: 'exact', amount: price, legacyText: row.legacy_raw_price }
        : { kind: 'legacy', text: row.legacy_raw_price! },
      urgency: row.urgency,
      location: row.location,
      resolution: row.resolution,
      viewer: {
        canSetResolution:
          actor === post.account_id &&
          actionAllowed(authority, 'resolve_trading'),
      },
    };
  }
}
