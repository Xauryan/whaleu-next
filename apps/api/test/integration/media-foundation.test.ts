import { verifyMediaOwnerFenceConcurrency } from '../support/media/owner-fence-concurrency.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import { MediaRequiredProof } from '../../src/media/required-proof.js';
import {
  MEDIA_ATTACHMENT,
  UnavailableMedia,
} from '../../src/community/community-policy.js';
import { sealManifest } from '../../src/media/manifest.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';

/** S0 database acceptance only. No decoder, ready assets, synthetic content
 * approval, Community publication, HTTP bytes or full S1 claims in this suite. */
test(
  'Media foundation is additive, immutable, fail-closed and a mandatory final owner',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    try {
      await verifyMediaOwnerFenceConcurrency(t, f.pool);
      const actor = await f.actor();
      const intent = randomUUID();
      await t.test(
        'ordinary runtime remains unavailable and schema contains no issued assets',
        async () => {
          assert.ok(f.app.get(MEDIA_ATTACHMENT) instanceof UnavailableMedia);
          assert.equal(
            (await f.pool.query('SELECT 1 FROM whaleu_media.assets')).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.asset_safety_events',
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.media_owner_states',
              )
            ).rowCount,
            128,
          );
        },
      );
      await t.test(
        'intent identity and quota are causal; upload alone cannot create ready',
        async () => {
          await withCommunityScopeWriter(f.pool, async (tx) => {
            await tx.query(
              `INSERT INTO whaleu_media.upload_intents
          (id,actor_id,client_request_id,canonical_intent_hash,purpose,audience,owner_kind,resource_kind,target_kind,resource_id,content_version,scope_revision,slot,ordinal,policy_revision,declared_bytes,declared_mime,expires_at)
          VALUES($1,$2,$3,$4,'community-post-image','content-gated','community','post','draft',$5,1,'synthetic-scope-v1','images',0,'media-static-v1',100,'image/png',clock_timestamp()+interval '30 minutes')`,
              [
                intent,
                actor.accountId,
                randomUUID(),
                'a'.repeat(64),
                randomUUID(),
              ],
            );
            await tx.query(
              `INSERT INTO whaleu_media.quota_reservations(intent_id,actor_id,window_start,reserved_bytes) VALUES($1,$2,CURRENT_DATE,100)`,
              [intent, actor.accountId],
            );
          });
          await assert.rejects(
            f.pool.query(
              `UPDATE whaleu_media.upload_intents SET resource_id=$2 WHERE id=$1`,
              [intent, randomUUID()],
            ),
          );
          await assert.rejects(
            f.pool.query(
              `UPDATE whaleu_media.upload_intents SET state='ready' WHERE id=$1`,
              [intent],
            ),
          );
          await assert.rejects(
            f.pool.query(
              `DELETE FROM whaleu_media.upload_intents WHERE id=$1`,
              [intent],
            ),
          );
          assert.equal(
            (
              await f.pool.query<{ state: string }>(
                'SELECT state FROM whaleu_media.upload_intents WHERE id=$1',
                [intent],
              )
            ).rows[0]?.state,
            'prepared',
          );
        },
      );
      await t.test(
        'SQL and TypeScript canonical manifest encoding match exact objects',
        async () => {
          const object = () => ({
            provider: 'local-fixture',
            environment: 'synthetic',
            bucket: 'synthetic',
            key: randomUUID(),
            version: randomUUID(),
          });
          const image = (width: number) => ({
            object: object(),
            sha256: 'b'.repeat(64),
            mime: 'image/png',
            bytes: 100,
            width,
            height: width,
          });
          const sealed = sealManifest({
            version: 1,
            policyVersion: 'media-static-v1',
            transformVersion: 'static-reencode-v1',
            original: image(800),
            variants: [
              { ...image(400), name: 'thumb-v1' },
              { ...image(800), name: 'display-v1' },
            ],
          });
          const result = (
            await f.pool.query<{ canonical: string; digest: string }>(
              `SELECT whaleu_media.canonical_json($1::jsonb) AS canonical,encode(sha256(convert_to(E'whaleu-media-manifest:v1\\n'||whaleu_media.canonical_json($1::jsonb),'UTF8')),'hex') AS digest`,
              [JSON.stringify(sealed.manifest)],
            )
          ).rows[0]!;
          assert.equal(result.canonical, sealed.canonical);
          assert.equal(result.digest, sealed.digest);
        },
      );
      await t.test(
        'unmanaged proof use fails; managed stable proof succeeds',
        async () => {
          const proof = new MediaRequiredProof();
          const client = await f.pool.connect();
          try {
            await assert.rejects(proof.capture(client));
          } finally {
            client.release();
          }
          await inTransaction(f.pool, (tx) => proof.capture(tx), {
            isolationLevel: 'read committed',
          });
        },
      );
      await t.test(
        'raw source table writer conflicts fail closed without optional downgrade',
        async () => {
          const writer = await f.pool.connect();
          try {
            await writer.query('BEGIN');
            await writer.query(
              'LOCK TABLE whaleu_media.bindings IN ROW EXCLUSIVE MODE',
            );
            await assert.rejects(
              inTransaction(
                f.pool,
                (tx) => new MediaRequiredProof().capture(tx),
                { isolationLevel: 'read committed' },
              ),
              /Media|media/i,
            );
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
      await t.test(
        'discarding an entire candidate restores its required facts at savepoint',
        async () => {
          const proof = new MediaRequiredProof();
          await inTransaction(
            f.pool,
            async (tx) => {
              const checkpoint = checkpointTransactionDeadlines(tx);
              await tx.query('SAVEPOINT media_candidate');
              await proof.capture(tx);
              await tx.query('ROLLBACK TO SAVEPOINT media_candidate');
              restoreTransactionDeadlines(tx, checkpoint);
              await tx.query('RELEASE SAVEPOINT media_candidate');
              await proof.capture(tx);
            },
            { isolationLevel: 'read committed' },
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
