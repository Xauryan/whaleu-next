import type { PoolClient } from 'pg';
import { sha } from './preflight.js';
export async function eraseIdentity(tx:PoolClient,account:string,request:string):Promise<string|null>{
 // Unsupported historical/session FK owners are rejected by full preflight.
 // No blanket CASCADE, trigger disable or fake logout label is used.
 await tx.query(`DELETE FROM whaleu_identity.sessions WHERE id IN(SELECT id FROM whaleu_identity.sessions WHERE account_id=$1 ORDER BY id LIMIT 100)`,[account]);
 if((await tx.query('SELECT 1 FROM whaleu_identity.sessions WHERE account_id=$1 LIMIT 1',[account])).rowCount)return null;
 await tx.query('DELETE FROM whaleu_identity.provider_identities WHERE account_id=$1',[account]);
 return sha(['identity-credential-erasure-v1',request,account]);
}
