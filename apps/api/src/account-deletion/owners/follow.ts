import type { PoolClient } from 'pg';
import { sha } from './preflight.js';
/** Pre-social/plain edges only. A real 0169 Follow has unsupported social owner
 * history and is blocked by preflight BEFORE this adapter removes anything. */
export async function eraseLegacyFollows(tx:PoolClient,account:string,request:string):Promise<string|null>{
 await tx.query(`UPDATE whaleu_community.follow_heads SET revision=revision+1 WHERE account_id<>$1 AND account_id IN(SELECT follower_id FROM whaleu_community.user_follows WHERE followed_id=$1 ORDER BY follower_id LIMIT 100)`,[account]);
 await tx.query(`DELETE FROM whaleu_community.user_follows WHERE (follower_id,followed_id) IN(SELECT follower_id,followed_id FROM whaleu_community.user_follows WHERE follower_id=$1 OR followed_id=$1 ORDER BY follower_id,followed_id LIMIT 100)`,[account]);
 await tx.query(`DELETE FROM whaleu_community.follow_requests WHERE (account_id,request_id) IN(SELECT account_id,request_id FROM whaleu_community.follow_requests WHERE account_id=$1 ORDER BY request_id LIMIT 100)`,[account]);
 if((await tx.query(`SELECT 1 FROM whaleu_community.user_follows WHERE follower_id=$1 OR followed_id=$1 UNION ALL SELECT 1 FROM whaleu_community.follow_requests WHERE account_id=$1 LIMIT 1`,[account])).rowCount)return null;
 await tx.query('DELETE FROM whaleu_community.follow_heads WHERE account_id=$1',[account]);
 return sha(['pre-social-follow-erasure-v1',request,account]);
}
