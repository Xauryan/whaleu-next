import type { PoolClient } from 'pg';
import { sha } from './preflight.js';
export async function eraseProfile(tx:PoolClient,account:string,request:string):Promise<string|null>{
 const changed=await tx.query(`UPDATE whaleu_profile.self_edit_causes SET patch='{}',before_row='{}',token_hash=repeat('0',64),erased_by_request_id=$2 WHERE id IN(SELECT id FROM whaleu_profile.self_edit_causes WHERE actor_id=$1 AND erased_by_request_id IS NULL ORDER BY id LIMIT 100)`,[account,request]);
 if(changed.rowCount===100)return null;
 await tx.query(`INSERT INTO whaleu_account_deletion.reserved_profile_ids(public_id,request_id) SELECT public_id,$2 FROM whaleu_profile.profiles WHERE account_id=$1 ON CONFLICT DO NOTHING`,[account,request]);
 await tx.query('DELETE FROM whaleu_profile.details WHERE account_id=$1',[account]);
 await tx.query('DELETE FROM whaleu_profile.profiles WHERE account_id=$1',[account]);
 const residue=(await tx.query(`SELECT 1 FROM whaleu_profile.self_edit_causes WHERE actor_id=$1 AND (erased_by_request_id IS NULL OR patch<>'{}' OR before_row<>'{}' OR token_hash<>repeat('0',64)) LIMIT 1`,[account])).rowCount;
 return residue?null:sha(['profile-erasure-v1',request,account]);
}
