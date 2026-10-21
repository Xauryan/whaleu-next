import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../database/database.js';
import { DeletionError } from './contracts.js';
import type { DeletionStatus, OwnerKey, Phase } from './contracts.js';
export interface RequestRow {id:string;account_id:string;generation:string;intent_hash:string;phase:Phase;revision:string;requested_at:Date;eligible_at:Date;irreversible_at:Date|null;completed_at:Date|null;reregister_after:Date|null;pending:string[];inventory:string;}
export function status(row:RequestRow):DeletionStatus{return {requestId:row.id,phase:row.phase,revision:String(row.revision),requestedAt:row.requested_at.getTime(),eligibleAt:row.eligible_at.getTime(),irreversibleAt:row.irreversible_at?.getTime()??null,completedAt:row.completed_at?.getTime()??null,reregisterAfter:row.reregister_after?.getTime()??null,pending:row.pending};}
export class AccountDeletionRepository {
 constructor(readonly pool:Pick<Pool,'connect'>){}
 transaction<T>(work:(tx:PoolClient)=>Promise<T>):Promise<T>{return inTransaction(this.pool,work,{isolationLevel:'read committed'});}
 async request(tx:PoolClient,id:string):Promise<RequestRow>{const row=(await tx.query<RequestRow>('SELECT * FROM whaleu_account_deletion.requests WHERE id=$1',[id])).rows[0];if(!row)throw new DeletionError('DELETION_NOT_FOUND');return row;}
 async lockAccount(tx:PoolClient,account:string){const row=(await tx.query<{id:string;status:string;lifecycle:string;lifecycle_generation:string}>('SELECT id,status,lifecycle,lifecycle_generation FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE NOWAIT',[account])).rows[0];if(!row)throw new DeletionError('DELETION_IDENTITY_UNAVAILABLE');return row;}
 async context(tx:PoolClient,account:string){const row=(await tx.query<{sandbox_id:string;now_at:Date;identity_digest:string}>('SELECT f.sandbox_id,s.now_at,f.identity_digest FROM whaleu_account_deletion.fixture_accounts f JOIN whaleu_account_deletion.sandboxes s ON s.id=f.sandbox_id WHERE f.account_id=$1 FOR SHARE OF s',[account])).rows[0];if(!row)throw new DeletionError('NON_SYNTHETIC_ACCOUNT');return row;}
 async cause(tx:PoolClient,row:RequestRow,owner:OwnerKey){await tx.query('INSERT INTO whaleu_account_deletion.owner_causes(request_id,owner,generation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[row.id,owner,row.generation]);}
 async proof(tx:PoolClient,row:RequestRow,owner:OwnerKey,proof:string){await tx.query('INSERT INTO whaleu_account_deletion.owner_receipts(request_id,owner,generation,inventory,proof) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[row.id,owner,row.generation,row.inventory,proof]);}
 async waiting(tx:PoolClient,row:RequestRow,reasons:readonly string[]){const pending=[...new Set(reasons.map(r=>r.split(':')[0]!))].sort();if(row.phase==='waiting'&&JSON.stringify(row.pending)===JSON.stringify(pending))return status(row);await tx.query("UPDATE whaleu_account_deletion.requests SET phase='waiting',revision=revision+1,pending=$2 WHERE id=$1",[row.id,pending]);return status(await this.request(tx,row.id));}
}
