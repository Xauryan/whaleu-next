import { randomBytes, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { cancelCommandSchema, requestCommandSchema, intentHash, DeletionError, SYNTHETIC_POLICY, INVENTORY_VERSION, COOLING_MS } from './contracts.js';
import type { DeletionStatus } from './contracts.js';
import { AccountDeletionRepository, status } from './repository.js';
import { SYNTHETIC_APP } from './synthetic-policy.js';
import { baselineProof } from './owners/baseline.js';
import { preflight } from './owners/preflight.js';
/** Server-verified assertion, never an account UUID/body-provided identity. No
 * production implementation is supplied. The verifier must enforce expiry,
 * audience and one-use/replay semantics before returning this value. */
export interface ExistingAccountReauthenticationPort {verify(assertion:unknown):Promise<{provider:'wechat';appId:string;subject:string;expiresAt:number}>;}
export const tokenHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export class AccountDeletionService {
 constructor(private readonly repository:AccountDeletionRepository,private readonly verifier:ExistingAccountReauthenticationPort){}
 private async resolve(tx:PoolClient,verified:Awaited<ReturnType<ExistingAccountReauthenticationPort['verify']>>){
  if(verified.provider!=='wechat'||verified.appId!==SYNTHETIC_APP)throw new DeletionError('NON_SYNTHETIC_IDENTITY');
  const row=(await tx.query<{account_id:string}>('SELECT account_id FROM whaleu_identity.provider_identities WHERE provider=$1 AND app_id=$2 AND subject=$3',[verified.provider,verified.appId,verified.subject])).rows[0];
  if(!row)throw new DeletionError('EXISTING_ACCOUNT_REQUIRED');
  const account=await this.repository.lockAccount(tx,row.account_id),context=await this.repository.context(tx,row.account_id);
  // Discovery preceded the account lock. Finalization may have removed the
  // mapping while we waited; its old account UUID is not a current identity.
  if(!(await tx.query('SELECT 1 FROM whaleu_identity.provider_identities WHERE provider=$1 AND app_id=$2 AND subject=$3 AND account_id=$4',[verified.provider,verified.appId,verified.subject,account.id])).rowCount)throw new DeletionError('EXISTING_ACCOUNT_REQUIRED');
  if(account.status!=='active'||verified.expiresAt<=context.now_at.getTime())throw new DeletionError('DELETION_IDENTITY_UNAVAILABLE');
  return {account,context};
 }
 async eligibility(assertion:unknown){const verified=await this.verifier.verify(assertion);return this.repository.transaction(async tx=>{const {account,context}=await this.resolve(tx,verified);if(account.lifecycle!=='active')return {status:'blocked' as const,blockers:['DELETION_ALREADY_PENDING']};const check=await preflight(tx,context.sandbox_id);try{await baselineProof(tx,account.id);}catch(error){if(error instanceof DeletionError)check.blockers.push(error.code);else throw error;}return {status:check.blockers.length?'blocked' as const:'eligible' as const,blockers:check.blockers,generation:String(account.lifecycle_generation)};});}
 async request(assertion:unknown,raw:unknown){const command=requestCommandSchema.parse(raw),verified=await this.verifier.verify(assertion);return this.repository.transaction(async tx=>{
  const {account,context}=await this.resolve(tx,verified),hash=intentHash(command);
  const old=(await tx.query<{intent_hash:string;receipt:DeletionStatus}>('SELECT intent_hash,receipt FROM whaleu_account_deletion.commands WHERE account_id=$1 AND command_id=$2',[account.id,command.requestId])).rows[0];
  if(old){if(old.intent_hash!==hash)throw new DeletionError('DELETION_IDEMPOTENCY_CONFLICT');return {status:old.receipt,receiptRecoveryKey:null};}
  if(account.lifecycle!=='active'||String(account.lifecycle_generation)!==command.expectedGeneration)throw new DeletionError('DELETION_GENERATION_STALE');
  const check=await preflight(tx,context.sandbox_id);if(check.blockers.length)throw new DeletionError('OWNER_COVERAGE_UNAVAILABLE');await baselineProof(tx,account.id);
  const recovery='deletion-receipt-'+randomBytes(32).toString('hex');
  await tx.query(`INSERT INTO whaleu_account_deletion.requests(id,account_id,generation,intent_hash,policy,inventory,phase,requested_at,eligible_at,receipt_key_hash) VALUES($1,$2,$3,$4,$5,$6,'cooling',$7,$8,$9)`,[command.requestId,account.id,String(BigInt(account.lifecycle_generation)+1n),hash,SYNTHETIC_POLICY,INVENTORY_VERSION,context.now_at,new Date(context.now_at.getTime()+COOLING_MS),tokenHash(recovery)]);
  const result=status(await this.repository.request(tx,command.requestId));
  await tx.query(`INSERT INTO whaleu_account_deletion.commands(account_id,command_id,request_id,intent_hash,outcome,receipt) VALUES($1,$2,$2,$3,'requested',$4::jsonb)`,[account.id,command.requestId,hash,JSON.stringify(result)]);
  return {status:result,receiptRecoveryKey:recovery};
 });}
 async reauthenticate(assertion:unknown,requestId:string){const verified=await this.verifier.verify(assertion);return this.repository.transaction(async tx=>{const {account,context}=await this.resolve(tx,verified),row=await this.repository.request(tx,requestId);if(row.account_id!==account.id||row.generation!==String(account.lifecycle_generation))throw new DeletionError('DELETION_IDENTITY_UNAVAILABLE');const token='deletion-scope-'+randomBytes(32).toString('hex');await tx.query(`INSERT INTO whaleu_account_deletion.recovery_grants(token_hash,request_id,generation,purpose,expires_at) VALUES($1,$2,$3,'account-deletion-status-cancel',$4)`,[tokenHash(token),row.id,row.generation,new Date(context.now_at.getTime()+15*60*1000)]);return {purpose:'account-deletion-status-cancel' as const,token,expiresAt:context.now_at.getTime()+15*60*1000};});}
 private async recover(tx:PoolClient,token:string,cancel=false){
  const found=(await tx.query<{id:string}>(cancel?`SELECT request_id id FROM whaleu_account_deletion.recovery_grants WHERE token_hash=$1`:`SELECT id FROM whaleu_account_deletion.requests WHERE receipt_key_hash=$1 UNION ALL SELECT request_id id FROM whaleu_account_deletion.recovery_grants WHERE token_hash=$1`,[tokenHash(token)])).rows[0];if(!found)throw new DeletionError('DELETION_IDENTITY_UNAVAILABLE');
  const discovered=await this.repository.request(tx,found.id),account=await this.repository.lockAccount(tx,discovered.account_id),row=await this.repository.request(tx,found.id),context=await this.repository.context(tx,row.account_id);
  if(token.startsWith('deletion-scope-')){const grant=(await tx.query<{generation:string;expires_at:Date}>('SELECT generation,expires_at FROM whaleu_account_deletion.recovery_grants WHERE token_hash=$1',[tokenHash(token)])).rows[0];if(!grant||grant.expires_at<=context.now_at||grant.generation!==String(account.lifecycle_generation)||account.status!=='active')throw new DeletionError('DELETION_IDENTITY_UNAVAILABLE');}
  else if(cancel||!token.startsWith('deletion-receipt-'))throw new DeletionError('DELETION_IDENTITY_UNAVAILABLE');
  return {row,account,context};
 }
 async status(token:string){return this.repository.transaction(async tx=>status((await this.recover(tx,token)).row));}
 async cancel(token:string,raw:unknown){const command=cancelCommandSchema.parse(raw);return this.repository.transaction(async tx=>{const {row,context}=await this.recover(tx,token,true);if(command.requestId!==row.id)throw new DeletionError('DELETION_IDENTITY_UNAVAILABLE');const hash=intentHash(command),old=(await tx.query<{intent_hash:string;receipt:DeletionStatus}>('SELECT intent_hash,receipt FROM whaleu_account_deletion.commands WHERE account_id=$1 AND command_id=$2',[row.account_id,command.commandId])).rows[0];if(old){if(old.intent_hash!==hash)throw new DeletionError('DELETION_IDEMPOTENCY_CONFLICT');return old.receipt;}if(row.phase!=='cooling'||row.revision!==command.expectedRevision)throw new DeletionError('CANCELLATION_STALE');if(context.now_at>=row.eligible_at)throw new DeletionError('CANCELLATION_TOO_LATE');await tx.query("UPDATE whaleu_account_deletion.requests SET phase='cancelled',revision=revision+1,cancelled_at=$2,pending='{}' WHERE id=$1",[row.id,context.now_at]);const result=status(await this.repository.request(tx,row.id));await tx.query("INSERT INTO whaleu_account_deletion.commands(account_id,command_id,request_id,intent_hash,outcome,receipt) VALUES($1,$2,$3,$4,'cancelled',$5::jsonb)",[row.account_id,command.commandId,row.id,hash,JSON.stringify(result)]);return result;});}
}
