/** TEST ONLY. This supplies a deliberately restricted authority for exercising
 * the real request state machine in a fresh disposable PG cluster. It is NOT a
 * production owner-coverage or maintenance-cutover implementation. No production
 * module imports this file; no database-name trust exists in production SQL. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { MIGRATION_LOCK } from '../../src/database/migrations.js';
import { boundedOwnerProof } from '../../src/database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  type RequiredTransactionProof,
} from '../../src/database/transaction-deadlines.js';
import { nativeBirthShapeSql } from '../../src/account-deletion/real/native-birth-shape.js';
import { fenceRequestProvider } from '../../src/account-deletion/real/request-repository.js';
import { retainRequestSchema } from '../../src/account-deletion/real/request-qualification.js';
import type { ReauthenticationScope } from '../../src/account-deletion/real/reauthentication.js';
import { ApplicationError } from '../../src/http/application-error.js';

const shapeBody = nativeBirthShapeSql
  .replace(
    "lifecycle='active' AND lifecycle_generation=0 AND session_revocation_epoch=0",
    "lifecycle=CASE WHEN $5::uuid IS NULL THEN 'active' ELSE 'cooling' END AND lifecycle_generation=CASE WHEN $5::uuid IS NULL THEN 0 ELSE 1 END AND session_revocation_epoch=CASE WHEN $5::uuid IS NULL THEN 0 ELSE 1 END",
  )
  .replace(
    'AND real_deletion_request_id IS NULL)',
    'AND real_deletion_request_id IS NOT DISTINCT FROM $5::uuid)',
  );
const guardBody = `DECLARE p whaleu_real_deletion.preparations;a whaleu_identity.accounts;subject text;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Local validation receipts are immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM whaleu_identity.accounts WHERE id=NEW.account_id FOR UPDATE NOWAIT;
 SELECT * INTO p FROM whaleu_real_deletion.preparations WHERE intent_id=NEW.request_id FOR SHARE NOWAIT;
 SELECT i.subject INTO STRICT subject FROM whaleu_identity.provider_identities i WHERE i.account_id=a.id AND i.provider='wechat' AND i.app_id=p.app_id;
 IF a.id IS NULL OR p.intent_id IS NULL OR p.account_id<>a.id OR p.next_generation<>NEW.generation OR p.base_generation<>0 OR NEW.previous_epoch<>0
 OR p.expires_at<=clock_timestamp() OR NOT whaleu_local_request_validation.native_birth(a.id,p.session_id,p.app_id,subject,NULL)
 THEN RAISE EXCEPTION 'Local native birth validation failed' USING ERRCODE='23514';END IF;
 NEW.owner_revision:='local-native-shape-not-complete-owner-coverage-v1';
 NEW.owner_evidence:=encode(sha256(convert_to(jsonb_build_array(NEW.owner_revision,NEW.request_id,NEW.account_id,NEW.generation)::text,'UTF8')),'hex');
 NEW.reader_revision:='isolated-test-cluster-not-production-cutover-v1';
 NEW.reader_evidence:=encode(sha256(convert_to(NEW.reader_revision||pg_current_xact_id()::text,'UTF8')),'hex');
 NEW.created_at:=clock_timestamp();NEW.valid_until:=least(p.expires_at,NEW.created_at+interval '30 seconds');NEW.creation_transaction:=pg_current_xact_id();RETURN NEW;
END`;
const functions = [
  [
    'whaleu_local_request_validation.native_birth(uuid,uuid,text,text,uuid)',
    shapeBody,
    'sql',
    'boolean',
  ],
  [
    'whaleu_real_deletion_admission.unavailable()',
    guardBody,
    'plpgsql',
    'trigger',
  ],
] as const;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export async function inspectLocalRequestValidation(tx: PoolClient) {
  for (const [name, body, language, result] of functions) {
    const rows = (
      await tx.query<{ body: string; valid: boolean }>(
        `SELECT CASE WHEN octet_length(p.prosrc)<=16384 THEN p.prosrc END body,p.prolang=(SELECT oid FROM pg_language WHERE lanname=$2) AND p.prorettype=to_regtype($3) AND NOT p.prosecdef AND NOT p.proretset AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] valid FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,
        [name, language, result],
      )
    ).rows;
    if (
      rows.length !== 1 ||
      rows[0]?.valid !== true ||
      typeof rows[0].body !== 'string' ||
      sha(rows[0].body) !== sha(body)
    )
      throw new ApplicationError('REAL_DELETION_UNAVAILABLE');
  }
}
/** An explicit test migration, not a production runtime switch. */
export async function installLocalRequestValidation(
  tx: PoolClient,
): Promise<void> {
  assert.equal(
    (await tx.query<{ db: string }>('SELECT current_database() db')).rows[0]
      ?.db,
    'whaleu_test',
  );
  await tx.query('SELECT pg_advisory_xact_lock($1,$2)', [...MIGRATION_LOCK]);
  await tx.query('CREATE SCHEMA whaleu_local_request_validation');
  await tx.query(
    `CREATE FUNCTION whaleu_local_request_validation.native_birth(uuid,uuid,text,text,uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $body$${shapeBody}$body$`,
  );
  await tx.query(
    `CREATE OR REPLACE FUNCTION whaleu_real_deletion_admission.unavailable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$${guardBody}$body$`,
  );
  await tx.query(`DO $marker$DECLARE seal text;BEGIN
 seal:=whaleu_real_deletion.request_catalog();IF seal IS NULL THEN RAISE EXCEPTION 'Local validation schema budget exceeded';END IF;
 EXECUTE format('CREATE OR REPLACE FUNCTION whaleu_real_deletion.request_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS %L','SELECT '||quote_literal(jsonb_build_object('version',1,'protocol','real-account-deletion-request-v1','migration','0182_real_deletion_request_authority.sql','admission','separate_owner_required','catalog',seal)::text)||'::jsonb');
 END$marker$`);
  await inspectLocalRequestValidation(tx);
}
const proof: RequiredTransactionProof<ReauthenticationScope> = {
  maximumFacts: 1,
  failureCode: 'REAL_DELETION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'REAL_DELETION_UNAVAILABLE', async (read) => {
      await inspectLocalRequestValidation(read);
      const f = facts[0];
      if (!f || facts.length !== 1)
        throw new ApplicationError('REAL_DELETION_UNAVAILABLE');
      const row = (
        await read.query<{ valid: boolean }>(
          `SELECT whaleu_local_request_validation.native_birth($1,p.session_id,$3,$4,$2) AND whaleu_real_deletion_admission.current_receipt($2,$1,$5,0) valid FROM whaleu_real_deletion.preparations p WHERE p.intent_id=$2 AND p.account_id=$1`,
          [f.accountId, f.requestId, f.appId, f.subject, f.generation],
        )
      ).rows;
      if (row.length !== 1 || row[0]?.valid !== true)
        throw new ApplicationError('REAL_DELETION_UNAVAILABLE');
    }),
};
export async function admitLocalRequestValidation(
  tx: PoolClient,
  input: ReauthenticationScope,
): Promise<void> {
  const scope = Object.freeze({ ...input });
  await retainRequestSchema(tx);
  await fenceRequestProvider(tx, scope);
  await inspectLocalRequestValidation(tx);
  await tx.query(
    `INSERT INTO whaleu_real_deletion_admission.receipts(request_id,account_id,generation,previous_epoch,owner_revision,owner_evidence,reader_revision,reader_evidence,valid_until) VALUES($1,$2,$3,0,'untrusted-input',$4,'untrusted-input',$4,clock_timestamp())`,
    [scope.requestId, scope.accountId, scope.generation, '0'.repeat(64)],
  );
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(tx, proof, scope.requestId, scope);
}
