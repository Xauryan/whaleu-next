import type { PoolClient } from 'pg';
import type { StoredComment, StoredReply } from '../community.repository.js';
import type {
  DefinitionPost,
  DefinitionSpace,
  DefinitionListing,
} from './definition-validation.js';
import type { SearchReadContext } from './search-read-context.js';

const sourceOwner = {};
/** Only these owner queries can populate shared canonical source facts. Keys
 * are kind-qualified even when multiple source tables use the same UUID. */
export function searchPost(
  id: string,
  tx: PoolClient,
  read: SearchReadContext,
) {
  return read.read(
    sourceOwner,
    `post:${id}`,
    tx,
    async () =>
      (
        await tx.query<DefinitionPost>(
          'SELECT * FROM whaleu_community.posts WHERE id=$1 FOR SHARE',
          [id],
        )
      ).rows[0],
    (row) => row !== undefined,
  );
}
export function searchRoot(
  id: string,
  tx: PoolClient,
  read: SearchReadContext,
) {
  return read.read(
    sourceOwner,
    `comment:${id}`,
    tx,
    async () =>
      (
        await tx.query<StoredComment>(
          'SELECT * FROM whaleu_community.root_comments WHERE id=$1 FOR SHARE',
          [id],
        )
      ).rows[0],
    (row) => row !== undefined,
  );
}
export function searchReply(
  id: string,
  tx: PoolClient,
  read: SearchReadContext,
) {
  return read.read(
    sourceOwner,
    `reply:${id}`,
    tx,
    async () =>
      (
        await tx.query<StoredReply>(
          'SELECT * FROM whaleu_community.replies WHERE id=$1 FOR SHARE',
          [id],
        )
      ).rows[0],
    (row) => row !== undefined,
  );
}
export function searchSpace(
  id: string,
  tx: PoolClient,
  read: SearchReadContext,
) {
  return read.read(
    sourceOwner,
    `space:${id}`,
    tx,
    async () =>
      (
        await tx.query<DefinitionSpace>(
          'SELECT id,is_active,kind,operating_region_id FROM whaleu_community.spaces WHERE id=$1 FOR SHARE',
          [id],
        )
      ).rows[0],
    (row) => row !== undefined,
  );
}
export function searchListing(
  id: string,
  tx: PoolClient,
  read: SearchReadContext,
) {
  return read.read(
    sourceOwner,
    `listing:${id}`,
    tx,
    async () =>
      (
        await tx.query<DefinitionListing>(
          'SELECT subtype,price::text,urgency,location,wechat,qq,phone,legacy_raw_price,legacy_raw_subtype FROM whaleu_community.trading_listings WHERE post_id=$1 FOR SHARE',
          [id],
        )
      ).rows[0],
    (row) => row !== undefined,
  );
}
