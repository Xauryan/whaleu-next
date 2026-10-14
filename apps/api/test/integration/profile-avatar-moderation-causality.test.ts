/** Raw SQL closure adversaries. Synthetic fixtures never activate production Media. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import request from 'supertest';
import { Client } from 'pg';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../src/config/config.js';
import { poolOptions } from '../../src/database/database.js';
import { hashToken } from '../../src/identity/tokens.js';
import { avatarModerationIntentHash } from '../../src/profile/avatar-moderation/evidence.js';
import type { AvatarModerationCommand } from '../../src/profile/avatar-moderation/contracts.js';
import { profileAvatarModerationFixture } from '../support/profile-avatar-moderation-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

const causal = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['23514', '23503', '23505', '23502', '22P02', '55P03'].includes(
    String(error.code),
  );
const exactFailure =
  (constraint: string, message?: string) => (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23514' &&
    'constraint' in error &&
    error.constraint === constraint &&
    (message === undefined ||
      ('message' in error && error.message === message));
const avatarFailure = exactFailure('profile_avatar_moderation_causal');
type Step =
  'profile' | 'definition' | 'pointer' | 'retirement' | 'event' | 'notice';
interface Fault {
  omit?: Step;
  profile?: 'zero' | 'extra' | 'nickname' | 'wrong_subject';
  pointer?: 'zero' | 'aba' | 'wrong_appearance';
  definition?: 'wrong_subject' | 'wrong_appearance' | 'self_authority';
  retirement?:
    'wrong_binding' | 'wrong_locator' | 'early_cleanup' | 'omit_detach';
  beforeRetirement?: (tx: PoolClient) => Promise<unknown>;
  beforeFinal?: (tx: PoolClient) => Promise<unknown>;
  after?: (tx: PoolClient) => Promise<unknown>;
}

test(
  'avatar moderation SQL requires exact dual transitions, retirement, audit and unread notice',
  { timeout: 240000 },
  async (t) => {
    const f = await profileAvatarModerationFixture(true);
    t.after(() => f.close());
    await t.test(
      'ancestry planning barrier preserves the original SQL body and invoker-only facts',
      async () => {
        const original = await readFile(
          new URL(
            '../../migrations/0128_scoped_profile_nickname_moderation.sql',
            import.meta.url,
          ),
          'utf8',
        );
        const body = original.match(
          /CREATE FUNCTION whaleu_community\.profile_moderation_nodes[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
        )?.[1];
        assert.ok(body);
        const definition = (
          await f.pool.query<{
            prosrc: string;
            proconfig: string[];
            prosecdef: boolean;
            provolatile: string;
            prorows: number;
          }>(
            `SELECT prosrc,proconfig,prosecdef,provolatile,prorows FROM pg_proc WHERE oid='whaleu_community.profile_moderation_nodes(text,uuid)'::regprocedure`,
          )
        ).rows[0]!;
        assert.equal(definition.prosrc, body);
        assert.deepEqual(definition.proconfig, ['search_path=pg_catalog']);
        assert.equal(definition.prosecdef, false);
        assert.equal(definition.provolatile, 's');
        assert.equal(definition.prorows, 3);
      },
    );
    const subject = await f.actor(),
      admin = await f.actor(),
      unrelated = await f.actor();
    const grant = await f.grant(admin);
    await f.custom(subject);
    await f.custom(unrelated);
    const post = await f.publish(subject, {}, true);
    const target = { kind: 'post' as const, id: post.id };
    const state = async () =>
      (
        await f.pool.query<{ revision: number; appearance_id: string }>(
          'SELECT p.revision,c.appearance_id FROM whaleu_profile.profiles p JOIN whaleu_profile.avatar_current c ON c.actor_id=p.account_id WHERE p.account_id=$1',
          [subject.accountId],
        )
      ).rows[0]!;
    const command = async () => {
      const current = await state();
      return f.command(target, current.revision, current.appearance_id);
    };
    const snapshot = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
    'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id) FROM whaleu_profile.profiles p),
    'pointers',(SELECT jsonb_agg(to_jsonb(c) ORDER BY actor_id) FROM whaleu_profile.avatar_current c),
    'definitions',(SELECT count(*) FROM whaleu_profile.avatar_definitions),
    'commands',(SELECT count(*) FROM whaleu_profile.avatar_moderation_commands),
    'profilesChanged',(SELECT count(*) FROM whaleu_profile.avatar_moderation_transitions),
    'pointersChanged',(SELECT count(*) FROM whaleu_profile.avatar_moderation_pointer_transitions),
    'events',(SELECT count(*) FROM whaleu_profile.avatar_moderation_events),
    'statements',(SELECT count(*) FROM whaleu_profile.avatar_moderation_media_statements),
    'epochs',(SELECT count(*) FROM whaleu_profile.avatar_moderation_media_epochs),
    'derivedEpochs',(SELECT count(*) FROM whaleu_profile.avatar_moderation_rating_epochs),
    'notices',(SELECT count(*) FROM whaleu_notifications.profile_avatar_moderation_notices),
    'registry',(SELECT count(*) FROM whaleu_notifications.system_notice_ids),
    'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM whaleu_media.bindings b),
    'intents',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM whaleu_media.upload_intents i),
    'quota',(SELECT jsonb_agg(to_jsonb(q) ORDER BY intent_id) FROM whaleu_media.quota_reservations q),
    'ingress',(SELECT jsonb_agg(to_jsonb(g) ORDER BY object_attempt_id) FROM whaleu_media.upload_ingress g),
    'cleanup',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM whaleu_media.cleanup_obligations c),
    'targetMedia',whaleu_profile.avatar_moderation_media_facts('post',$1)) value`,
          [post.id],
        )
      ).rows[0]!.value;
    const transaction = async <T>(
      work: (tx: PoolClient) => Promise<T>,
    ): Promise<T> => {
      const tx = await f.pool.connect();
      try {
        await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await tx.query(
          "SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='8s'",
        );
        const result = await work(tx);
        await tx.query('COMMIT');
        return result;
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      } finally {
        tx.release();
      }
    };
    const raw = async (body: AvatarModerationCommand, fault: Fault = {}) =>
      transaction(async (tx) => {
        const now = (
          await tx.query<{ now: Date }>(
            "SELECT date_trunc('milliseconds',clock_timestamp()) now",
          )
        ).rows[0]!.now;
        const receipt = {
          requestId: body.clientRequestId,
          target: body.target,
          expectedProfileRevision: body.expectedProfileRevision,
          expectedAppearanceId: body.expectedAppearanceId,
          action: body.action,
          outcome: 'applied' as const,
          revision: body.expectedProfileRevision + 1,
          eventId: randomUUID(),
          recordedAt: now.toISOString(),
        };
        await tx.query(
          `INSERT INTO whaleu_profile.avatar_moderation_commands
      (actor_id,request_id,session_id,token_hash,target_kind,target_id,intent_hash,command,receipt,grant_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            admin.accountId,
            body.clientRequestId,
            admin.sessionId,
            hashToken(admin.accessToken),
            body.target.kind,
            body.target.id,
            avatarModerationIntentHash(admin.accountId, body),
            body,
            receipt,
            grant,
          ],
        );
        const keys = [admin.accountId, body.clientRequestId];
        const cause = (
          await tx.query<{
            appearance_id: string;
            old_binding_id: string;
            old_asset_id: string;
            old_intent_id: string;
          }>(
            'SELECT appearance_id,old_binding_id,old_asset_id,old_intent_id FROM whaleu_profile.avatar_moderation_commands WHERE actor_id=$1 AND request_id=$2',
            keys,
          )
        ).rows[0]!;
        if (fault.omit !== 'profile') {
          await tx.query(
            `UPDATE whaleu_profile.profiles SET revision=revision+1,updated_at=clock_timestamp()
        WHERE account_id=$1 ${fault.profile === 'zero' ? 'AND false' : ''}`,
            [
              fault.profile === 'wrong_subject'
                ? unrelated.accountId
                : subject.accountId,
            ],
          );
          if (fault.profile === 'extra')
            await tx.query(
              'UPDATE whaleu_profile.profiles SET revision=revision WHERE account_id=$1',
              [subject.accountId],
            );
          if (fault.profile === 'nickname')
            await tx.query(
              "UPDATE whaleu_profile.profiles SET nickname='UnexpectedChange' WHERE account_id=$1",
              [subject.accountId],
            );
        }
        if (fault.omit !== 'definition') {
          await tx.query(
            `INSERT INTO whaleu_profile.avatar_definitions(id,actor_id,slot,source,envelope,digest,binding_id,authority)
        SELECT ${fault.definition === 'wrong_appearance' ? 'gen_random_uuid()' : 'q.appearance_id'},
        ${fault.definition === 'wrong_subject' ? '$3::uuid' : 'q.subject_id'},'avatar','{"kind":"clear"}',
        whaleu_profile.avatar_moderation_envelope(q),encode(sha256(convert_to('whaleu-profile-avatar-moderation:v1'||chr(10)||whaleu_community.content_canonical_json(whaleu_profile.avatar_moderation_envelope(q)),'UTF8')),'hex'),NULL,
        '${fault.definition === 'self_authority' ? 'self_selection' : 'scoped_moderation_clear'}'
        FROM whaleu_profile.avatar_moderation_commands q WHERE actor_id=$1 AND request_id=$2`,
            fault.definition === 'wrong_subject'
              ? [...keys, unrelated.accountId]
              : keys,
          );
        }
        if (fault.omit !== 'pointer') {
          await tx.query(
            `UPDATE whaleu_profile.avatar_current SET appearance_id=$2 WHERE actor_id=$1 ${fault.pointer === 'zero' ? 'AND false' : ''}`,
            [
              subject.accountId,
              fault.pointer === 'wrong_appearance'
                ? randomUUID()
                : cause.appearance_id,
            ],
          );
          if (fault.pointer === 'aba') {
            await tx.query(
              'UPDATE whaleu_profile.avatar_current SET appearance_id=$2 WHERE actor_id=$1',
              [subject.accountId, body.expectedAppearanceId],
            );
            await tx.query(
              'UPDATE whaleu_profile.avatar_current SET appearance_id=$2 WHERE actor_id=$1',
              [subject.accountId, cause.appearance_id],
            );
          }
        }
        if (fault.beforeRetirement) await fault.beforeRetirement(tx);
        if (fault.omit !== 'retirement') {
          // Same precise retirement protocol as the owner, expressed as raw SQL so
          // this gate does not rely on application required-proof registration.
          if (fault.retirement !== 'omit_detach')
            await tx.query(
              `UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='profile-avatar-replaced' WHERE id=${fault.retirement === 'wrong_binding' ? '(SELECT d.binding_id FROM whaleu_profile.avatar_current c JOIN whaleu_profile.avatar_definitions d ON d.id=c.appearance_id WHERE c.actor_id=$1)' : '$1'} AND detached_at IS NULL`,
              [
                fault.retirement === 'wrong_binding'
                  ? unrelated.accountId
                  : cause.old_binding_id,
              ],
            );
          await tx.query(
            `INSERT INTO whaleu_media.cleanup_obligations(id,effect_key,object_attempt_id,provider,environment,bucket,object_key,object_version,reason,not_before)
        SELECT gen_random_uuid(),'cleanup:'||a.id||':'||o.kind,a.id,a.provider,a.environment,${fault.retirement === 'wrong_locator' ? "'other-owner-bucket'" : 'o.bucket'},o.key,o.version,'intent-cancelled',clock_timestamp()+interval '${fault.retirement === 'early_cleanup' ? '1 minute' : '2 minutes'}'
        FROM whaleu_media.object_attempts a CROSS JOIN LATERAL (VALUES('staging',a.staging_bucket,a.staging_key,a.source_version),('sealed',a.sealed_bucket,a.sealed_key,a.sealed_version)) o(kind,bucket,key,version)
        WHERE a.intent_id=$1 AND o.version IS NOT NULL ON CONFLICT(provider,environment,bucket,object_key,object_version) DO NOTHING`,
            [cause.old_intent_id],
          );
          await tx.query(
            `INSERT INTO whaleu_media.cleanup_obligations(id,effect_key,derived_attempt_id,provider,environment,bucket,object_key,object_version,reason,not_before)
        SELECT gen_random_uuid(),'cleanup:derived:'||d.id,d.id,d.provider,d.environment,d.bucket,d.object_key,d.object_version,'intent-terminal',clock_timestamp()+interval '2 minutes'
        FROM whaleu_media.derived_object_attempts d WHERE d.intent_id=$1 ON CONFLICT(provider,environment,bucket,object_key,object_version) DO NOTHING`,
            [cause.old_intent_id],
          );
          await tx.query(
            `INSERT INTO whaleu_media.cleanup_obligations(id,effect_key,asset_id,variant_name,provider,environment,bucket,object_key,object_version,reason,not_before)
        SELECT gen_random_uuid(),'cleanup:'||v.asset_id||':'||v.variant_name,v.asset_id,v.variant_name,v.provider,v.environment,v.bucket,v.object_key,v.object_version,'intent-cancelled',clock_timestamp()+interval '2 minutes'
        FROM whaleu_media.variants v WHERE v.asset_id=$1 ON CONFLICT(provider,environment,bucket,object_key,object_version) DO NOTHING`,
            [cause.old_asset_id],
          );
          await tx.query(
            "UPDATE whaleu_media.upload_ingress SET writer_state='retiring' WHERE intent_id=$1 AND writer_state='writing'",
            [cause.old_intent_id],
          );
          await tx.query(
            "UPDATE whaleu_media.upload_intents SET state='cleanup_pending',generation=generation+1,updated_at=clock_timestamp() WHERE id=$1 AND state='ready'",
            [cause.old_intent_id],
          );
          await tx.query(
            'UPDATE whaleu_media.quota_reservations SET released_at=clock_timestamp() WHERE intent_id=$1 AND released_at IS NULL',
            [cause.old_intent_id],
          );
        }
        if (fault.omit !== 'event')
          await tx.query(
            `INSERT INTO whaleu_profile.avatar_moderation_events
      (id,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,before_revision,revision,previous_appearance_id,appearance_id,old_binding_id,recorded_at)
      SELECT (receipt->>'eventId')::uuid,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,before_revision,before_revision+1,previous_appearance_id,appearance_id,old_binding_id,(receipt->>'recordedAt')::timestamptz
      FROM whaleu_profile.avatar_moderation_commands WHERE actor_id=$1 AND request_id=$2`,
            keys,
          );
        if (fault.omit !== 'notice')
          await tx.query(
            `INSERT INTO whaleu_notifications.profile_avatar_moderation_notices(id,event_id,recipient_account_id,created_at)
      VALUES($1,$2,$3,$4)`,
            [
              randomUUID(),
              receipt.eventId,
              subject.accountId,
              receipt.recordedAt,
            ],
          );
        if (fault.beforeFinal) await fault.beforeFinal(tx);
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        if (fault.after) await fault.after(tx);
        return { receipt, appearanceId: cause.appearance_id };
      });
    const rejectsWithoutEffects = async (
      name: string,
      fault: Fault,
      expected: (error: unknown) => boolean = causal,
    ) => {
      const before = await snapshot(),
        body = await command();
      await assert.rejects(raw(body, fault), expected, name);
      assert.deepEqual(
        await snapshot(),
        before,
        `${name}: every tentative effect rolls back`,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_profile.avatar_moderation_commands WHERE actor_id=$1 AND request_id=$2',
            [admin.accountId, body.clientRequestId],
          )
        ).rowCount,
        0,
      );
    };

    await t.test(
      'omitting any required effect and wrong or extra owner transitions roll back',
      async () => {
        for (const omit of [
          'profile',
          'definition',
          'pointer',
          'retirement',
          'event',
          'notice',
        ] as const)
          await rejectsWithoutEffects(`missing ${omit}`, { omit });
        for (const profile of [
          'zero',
          'extra',
          'nickname',
          'wrong_subject',
        ] as const)
          await rejectsWithoutEffects(`Profile ${profile}`, { profile });
        for (const pointer of ['zero', 'aba', 'wrong_appearance'] as const)
          await rejectsWithoutEffects(`pointer ${pointer}`, { pointer });
        for (const definition of [
          'wrong_subject',
          'wrong_appearance',
          'self_authority',
        ] as const)
          await rejectsWithoutEffects(`definition ${definition}`, {
            definition,
          });
        for (const retirement of [
          'wrong_binding',
          'wrong_locator',
          'early_cleanup',
          'omit_detach',
        ] as const)
          await rejectsWithoutEffects(`retirement ${retirement}`, {
            retirement,
          });
      },
    );

    await t.test(
      'SET CONSTRAINTS IMMEDIATE cannot release late source, identity, pointer or Media writes',
      async () => {
        const changes: Array<[string, (tx: PoolClient) => Promise<unknown>]> = [
          [
            'zero-row Media assets',
            (tx) =>
              tx.query(
                'UPDATE whaleu_media.assets SET manifest=manifest WHERE false',
              ),
          ],
          [
            'zero-row extra retirement',
            (tx) =>
              tx.query(
                'UPDATE whaleu_media.bindings SET detached_at=detached_at WHERE false',
              ),
          ],
          [
            'target same-value Media',
            (tx) =>
              tx.query(
                "UPDATE whaleu_media.bindings SET detached_at=detached_at WHERE owner_kind='community' AND resource_id=$1",
                [post.id],
              ),
          ],
          [
            'target Media Safety same-value',
            (tx) =>
              tx.query(
                "UPDATE whaleu_media.asset_safety_heads SET revision=revision WHERE asset_id IN(SELECT asset_id FROM whaleu_media.bindings WHERE owner_kind='community' AND resource_id=$1)",
                [post.id],
              ),
          ],
          [
            'target source ABA',
            async (tx) => {
              await tx.query(
                "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                [post.id],
              );
              await tx.query(
                "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
                [post.id],
              );
            },
          ],
          [
            'target source same-value',
            (tx) =>
              tx.query(
                'UPDATE whaleu_community.posts SET text=text WHERE id=$1',
                [post.id],
              ),
          ],
          [
            'late Profile no-op',
            (tx) =>
              tx.query(
                'UPDATE whaleu_profile.profiles SET revision=revision WHERE account_id=$1',
                [subject.accountId],
              ),
          ],
          [
            'late pointer no-op',
            (tx) =>
              tx.query(
                'UPDATE whaleu_profile.avatar_current SET appearance_id=appearance_id WHERE actor_id=$1',
                [subject.accountId],
              ),
          ],
          [
            'grant revoke',
            (tx) =>
              tx.query(
                'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
                [grant, admin.accountId],
              ),
          ],
          [
            'token revoke',
            (tx) =>
              tx.query(
                'DELETE FROM whaleu_identity.access_tokens WHERE token_hash=$1',
                [hashToken(admin.accessToken)],
              ),
          ],
          [
            'extra old-intent cleanup statement',
            (tx) =>
              tx.query(
                'INSERT INTO whaleu_media.cleanup_obligations SELECT * FROM whaleu_media.cleanup_obligations WHERE false',
              ),
          ],
        ];
        for (const [name, after] of changes)
          await rejectsWithoutEffects(name, { after });
      },
    );

    await t.test(
      'all external source writers remain rejected after raw constraints become immediate',
      async () => {
        const sources = (
          await f.pool.query<{
            mutation: string;
          }>(`SELECT DISTINCT format('UPDATE %I.%I SET %I=%I WHERE false',n.nspname,c.relname,a.attname,a.attname) mutation
          FROM pg_trigger source JOIN pg_class c ON c.oid=source.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          JOIN LATERAL(SELECT attname FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum LIMIT 1) a ON true
          WHERE source.tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure AND NOT source.tgisinternal AND source.tgenabled<>'D' AND n.nspname<>'whaleu_media' ORDER BY mutation`)
        ).rows;
        assert.equal(sources.length, 12);
        for (const source of sources)
          await rejectsWithoutEffects(source.mutation, {
            after: (tx) => tx.query(source.mutation),
          });
        await rejectsWithoutEffects(
          'new unguarded source created after immediate closure',
          {
            after: (tx) =>
              tx.query(`CREATE TABLE whaleu_profile.avatar_moderation_late_epoch_source(id uuid PRIMARY KEY);
            CREATE TRIGGER a1_late_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.avatar_moderation_late_epoch_source FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch();
            UPDATE whaleu_profile.avatar_moderation_late_epoch_source SET id=id WHERE false`),
          },
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT to_regclass('whaleu_profile.avatar_moderation_late_epoch_source') relation",
            )
          ).rows[0]!.relation,
          null,
          'Late source DDL and every tentative effect roll back together',
        );
      },
    );

    await t.test(
      'standalone transition, event, definition, notice and registry entries cannot forge a command',
      async () => {
        const before = await snapshot(),
          current = await state();
        const body = await command(),
          appearanceId = randomUUID(),
          eventId = randomUUID();
        const envelope = {
          version: 1,
          purpose: 'moderate_profile_avatar_clear',
          accountId: subject.accountId,
          moderatorAccountId: admin.accountId,
          clientRequestId: body.clientRequestId,
          eventId,
          target,
          originalRegionId: f.scope.home.regionId,
          expectedRevision: current.revision,
          appearanceId,
          previousAppearanceId: current.appearance_id,
          slot: 'avatar',
          source: { kind: 'clear' },
        };
        const attempts: Array<() => Promise<unknown>> = [
          () =>
            f.pool.query(
              `INSERT INTO whaleu_profile.avatar_moderation_transitions(actor_id,request_id,subject_id,before_revision,after_revision,before_hash,after_hash,after_fingerprint,unchanged_hash) VALUES($1,$2,$3,0,1,'forged','forged','forged','forged')`,
              [admin.accountId, body.clientRequestId, subject.accountId],
            ),
          () =>
            f.pool.query(
              `INSERT INTO whaleu_profile.avatar_moderation_pointer_transitions(actor_id,request_id,subject_id,previous_appearance_id,appearance_id,before_hash,after_hash) VALUES($1,$2,$3,$4,$5,'forged','forged')`,
              [
                admin.accountId,
                body.clientRequestId,
                subject.accountId,
                current.appearance_id,
                appearanceId,
              ],
            ),
          () =>
            f.pool.query(
              `INSERT INTO whaleu_profile.avatar_definitions(id,actor_id,slot,source,envelope,digest,authority) VALUES($1,$2,'avatar','{"kind":"clear"}',$3,encode(sha256(convert_to('whaleu-profile-avatar-moderation:v1'||chr(10)||whaleu_community.content_canonical_json($3::jsonb),'UTF8')),'hex'),'scoped_moderation_clear')`,
              [appearanceId, subject.accountId, envelope],
            ),
          () =>
            f.pool.query(
              `INSERT INTO whaleu_profile.avatar_moderation_events(id,actor_id,request_id,subject_id,target_kind,target_id,post_id,original_region_id,grant_id,before_revision,revision,previous_appearance_id,appearance_id,old_binding_id,recorded_at) VALUES($1,$2,$3,$4,'post',$5,$5,$6,$7,0,1,$8,$9,$10,date_trunc('milliseconds',clock_timestamp()))`,
              [
                eventId,
                admin.accountId,
                body.clientRequestId,
                subject.accountId,
                post.id,
                f.scope.home.regionId,
                grant,
                current.appearance_id,
                appearanceId,
                randomUUID(),
              ],
            ),
          () =>
            f.pool.query(
              "INSERT INTO whaleu_notifications.profile_avatar_moderation_notices(id,event_id,recipient_account_id,created_at) VALUES($1,$2,$3,date_trunc('milliseconds',clock_timestamp()))",
              [randomUUID(), eventId, subject.accountId],
            ),
          () =>
            f.pool.query(
              "INSERT INTO whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) VALUES($1,'profile_custom_avatar_cleared',$2)",
              [randomUUID(), subject.accountId],
            ),
        ];
        for (const attempt of attempts) {
          await assert.rejects(attempt(), causal);
          assert.deepEqual(await snapshot(), before);
        }
      },
    );

    await t.test(
      'rating-derived receipts never absorb unrelated zero-row writers before or after final closure',
      async () => {
        for (const relation of [
          'whaleu_ratings.navigation_epoch',
          'whaleu_community.rating_target_link_generation',
          'whaleu_community.post_rating_target_links',
        ]) {
          const column = relation.endsWith('post_rating_target_links')
            ? 'post_id'
            : 'singleton';
          const mutate = (tx: PoolClient) =>
            tx.query(`UPDATE ${relation} SET ${column}=${column} WHERE false`);
          await rejectsWithoutEffects(
            `pre-chain unrelated ${relation}`,
            { beforeRetirement: mutate },
            avatarFailure,
          );
          await rejectsWithoutEffects(
            `early unrelated ${relation}`,
            {
              beforeFinal: mutate,
            },
            avatarFailure,
          );
          await rejectsWithoutEffects(
            `late unrelated ${relation}`,
            {
              after: mutate,
            },
            avatarFailure,
          );
        }
      },
    );
    await t.test(
      'an admitted generation writer without a visible epoch change blocks final avatar proof',
      async () => {
        const blocker = await f.pool.connect();
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            'LOCK TABLE whaleu_community.rating_target_link_generation IN ROW EXCLUSIVE MODE',
          );
          let reachedFinal = false;
          await rejectsWithoutEffects(
            'in-flight generation source',
            {
              beforeFinal: async () => {
                reachedFinal = true;
              },
            },
            (error: unknown) =>
              reachedFinal &&
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === '55P03' &&
              'where' in error &&
              typeof error.where === 'string' &&
              error.where.includes('avatar_moderation_assert_complete') &&
              error.where.includes(
                'LOCK TABLE whaleu_community.rating_target_link_generation',
              ),
          );
          assert.equal(
            reachedFinal,
            true,
            'The complete lawful retirement reached final proof',
          );
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
      },
    );
    await t.test(
      'derived receipt omission, duplication, foreign attribution and mutation roll back the complete clear',
      async () => {
        await rejectsWithoutEffects(
          'omitted derivative receipt',
          {
            beforeRetirement: (tx) =>
              tx.query(`
            CREATE FUNCTION whaleu_profile.test_suppress_avatar_rating_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;
            CREATE TRIGGER zz_test_suppress_avatar_rating_receipt BEFORE INSERT ON whaleu_profile.avatar_moderation_rating_epochs FOR EACH ROW EXECUTE FUNCTION whaleu_profile.test_suppress_avatar_rating_receipt()`),
          },
          exactFailure(
            'profile_avatar_moderation_causal',
            'Unconsumed avatar Media epoch required',
          ),
        );
        for (const sql of [
          'UPDATE whaleu_profile.avatar_moderation_rating_epochs SET after_generation=gen_random_uuid() WHERE true',
          'UPDATE whaleu_profile.avatar_moderation_rating_epochs SET after_generation=after_generation WHERE false',
          'DELETE FROM whaleu_profile.avatar_moderation_rating_epochs',
          'TRUNCATE whaleu_profile.avatar_moderation_rating_epochs',
          'INSERT INTO whaleu_profile.avatar_moderation_rating_epochs SELECT * FROM whaleu_profile.avatar_moderation_rating_epochs LIMIT 1',
          `INSERT INTO whaleu_profile.avatar_moderation_rating_epochs(actor_id,request_id,statement_sequence,slot,version,before_epoch,after_epoch,before_hash,after_hash,before_generation,after_generation,mutation_transaction)
           SELECT gen_random_uuid(),request_id,statement_sequence,slot,version,before_epoch,after_epoch,before_hash,after_hash,before_generation,after_generation,mutation_transaction FROM whaleu_profile.avatar_moderation_rating_epochs LIMIT 1`,
        ])
          await rejectsWithoutEffects(
            sql,
            {
              [sql.startsWith('TRUNCATE') ? 'after' : 'beforeFinal']: (
                tx: PoolClient,
              ) => tx.query(sql),
            },
            sql.startsWith('INSERT')
              ? exactFailure(
                  'profile_avatar_moderation_causal',
                  'Exact avatar-owned rating generation transition required',
                )
              : exactFailure(
                  'profile_moderation_causal',
                  'Profile moderation evidence is immutable',
                ),
          );
      },
    );

    await t.test(
      'raw complete cause commits, immutable history cannot be replayed and old receipts do not restore bytes',
      async () => {
        const body = await command();
        const originalAppearance = body.expectedAppearanceId;
        const applied = await raw(body, {
          after: async (tx) => {
            const proof = (
              await tx.query<{
                current: boolean;
                media: number;
                derived: number;
                inventory: boolean;
              }>(
                `
              SELECT whaleu_profile.avatar_moderation_rating_inputs_current(q) current,
              (SELECT count(*)::int FROM whaleu_profile.avatar_moderation_media_epochs e WHERE(e.actor_id,e.request_id)=(q.actor_id,q.request_id)) media,
              (SELECT count(*)::int FROM whaleu_profile.avatar_moderation_rating_epochs e WHERE(e.actor_id,e.request_id)=(q.actor_id,q.request_id)) derived,
              whaleu_profile.avatar_moderation_rating_epoch_inventory_current() inventory
              FROM whaleu_profile.avatar_moderation_commands q WHERE(actor_id,request_id)=($1,$2)`,
                [admin.accountId, body.clientRequestId],
              )
            ).rows[0]!;
            assert.equal(proof.current, true);
            assert.equal(proof.inventory, true);
            assert.ok(proof.media > 0 && proof.media <= 7);
            assert.equal(proof.derived, proof.media);
            const bridge = (
              await tx.query<{
                valid: boolean;
                wrong_actor: unknown;
                wrong_request: unknown;
                wrong_target: unknown;
              }>(
                `SELECT whaleu_profile.avatar_moderation_command_community($1,$2,$3,$4) IS NOT NULL valid,
               whaleu_profile.avatar_moderation_command_community(gen_random_uuid(),$2,$3,$4) wrong_actor,
               whaleu_profile.avatar_moderation_command_community($1,gen_random_uuid(),$3,$4) wrong_request,
               whaleu_profile.avatar_moderation_command_community($1,$2,$3,gen_random_uuid()) wrong_target`,
                [
                  admin.accountId,
                  body.clientRequestId,
                  body.target.kind,
                  body.target.id,
                ],
              )
            ).rows[0]!;
            assert.deepEqual(bridge, {
              valid: true,
              wrong_actor: null,
              wrong_request: null,
              wrong_target: null,
            });
          },
        });
        assert.equal(
          (
            await f.pool.query(
              'SELECT whaleu_profile.avatar_moderation_command_community($1,$2,$3,$4) value',
              [
                admin.accountId,
                body.clientRequestId,
                body.target.kind,
                body.target.id,
              ],
            )
          ).rows[0]!.value,
          null,
          'historical receipt cannot normalize a new transaction',
        );
        assert.equal((await state()).appearance_id, applied.appearanceId);
        assert.equal(
          (await state()).revision,
          body.expectedProfileRevision + 1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT whaleu_profile.avatar_moderation_definition_authorized($1) valid',
              [applied.appearanceId],
            )
          ).rows[0]!.valid,
          true,
        );
        const replay = await f.send(admin, body);
        profileOk(replay);
        assert.deepEqual(replay.body, applied.receipt);
        const sourceLocker = await f.pool.connect();
        try {
          await sourceLocker.query('BEGIN');
          await sourceLocker.query(
            'LOCK TABLE whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_profile.profiles,whaleu_media.assets IN ACCESS EXCLUSIVE MODE',
          );
          await sourceLocker.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0))",
          );
          const terminal = await f.send(admin, body);
          profileOk(terminal);
          assert.deepEqual(terminal.body, applied.receipt);
          const insertRaw = (
            client: Client,
            intent: AvatarModerationCommand,
            receipt: object,
            selectedGrant: string | null,
          ) =>
            client.query(
              `INSERT INTO whaleu_profile.avatar_moderation_commands(actor_id,request_id,session_id,token_hash,target_kind,target_id,intent_hash,command,receipt,grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                admin.accountId,
                intent.clientRequestId,
                admin.sessionId,
                hashToken(admin.accessToken),
                intent.target.kind,
                intent.target.id,
                avatarModerationIntentHash(admin.accountId, intent),
                intent,
                receipt,
                selectedGrant,
              ],
            );
          for (const cancel of [false, true]) {
            // A brand-new backend has never compiled any PL/pgSQL owner function.
            // Neither duplicate rejection nor cancellation may open a source rowtype.
            const cold = new Client(poolOptions(f.app.get(APP_CONFIG)));
            await cold.connect();
            try {
              await cold.query('BEGIN ISOLATION LEVEL READ COMMITTED');
              await cold.query(
                "SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='8s'",
              );
              if (!cancel) {
                await assert.rejects(
                  insertRaw(cold, body, applied.receipt, grant),
                  (error) =>
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    error.code === '23505',
                );
                await cold.query('ROLLBACK');
              } else {
                const intent = { ...body, clientRequestId: randomUUID() };
                const receipt = {
                  requestId: intent.clientRequestId,
                  target: intent.target,
                  expectedProfileRevision: intent.expectedProfileRevision,
                  expectedAppearanceId: intent.expectedAppearanceId,
                  action: intent.action,
                  outcome: 'rejected',
                  code: 'PROFILE_AVATAR_MODERATION_CANCELLED',
                };
                await insertRaw(cold, intent, receipt, null);
                await cold.query('SET CONSTRAINTS ALL IMMEDIATE');
                await cold.query('COMMIT');
              }
            } finally {
              await cold.end();
            }
          }
          const coldApp = await f.startOrdinaryRuntime();
          const cancelled = await request(coldApp.getHttpServer())
            .post('/v1/community/profile-avatar-moderation/commands/cancel')
            .set('Authorization', `Bearer ${admin.accessToken}`)
            .send({ ...body, clientRequestId: randomUUID() });
          profileOk(cancelled);
          assert.equal(
            cancelled.body.code,
            'PROFILE_AVATAR_MODERATION_CANCELLED',
          );
        } finally {
          await sourceLocker.query('ROLLBACK');
          sourceLocker.release();
        }
        const next = await f.custom(subject);
        const before = await snapshot();
        await assert.rejects(
          transaction(async (tx) => {
            // Even a raw revision rewind cannot reuse a historical system event.
            await tx.query(
              'UPDATE whaleu_profile.profiles SET revision=$2 WHERE account_id=$1',
              [subject.accountId, applied.receipt.revision],
            );
            await tx.query(
              'UPDATE whaleu_profile.avatar_current SET appearance_id=$2 WHERE actor_id=$1',
              [subject.accountId, applied.appearanceId],
            );
          }),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_profile.avatar_current SET appearance_id=$2 WHERE actor_id=$1',
            [subject.accountId, originalAppearance],
          ),
          causal,
        );
        assert.deepEqual(await snapshot(), before);
        const recovery = await f.send(admin, body);
        profileOk(recovery);
        assert.deepEqual(recovery.body, applied.receipt);
        assert.equal((await state()).appearance_id, next.appearanceId);
        for (const relation of [
          'avatar_moderation_commands',
          'avatar_moderation_transitions',
          'avatar_moderation_pointer_transitions',
          'avatar_moderation_events',
          'avatar_moderation_media_statements',
          'avatar_moderation_rating_epochs',
        ])
          await assert.rejects(
            f.pool.query(
              `DELETE FROM whaleu_profile.${relation} WHERE actor_id=$1 AND request_id=$2`,
              [admin.accountId, body.clientRequestId],
            ),
            causal,
          );
        assert.deepEqual(await snapshot(), before);
      },
    );
  },
);

// Regression first written against the pre-fix migration. A zero-row external
// owner writer after admission used to enter the final Media epoch unnoticed.
test(
  'avatar moderation rejects every external Media epoch writer after admission',
  { timeout: 180000 },
  async (t) => {
    const f = await profileAvatarModerationFixture(true);
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor();
    await f.grant(admin);
    const selected = await f.custom(subject),
      target = await f.publish(subject, {}, true);
    const { DatabaseService } = await import('../../src/database/database.js');
    const database = f.moderationApp.get(DatabaseService);
    const sources = (
      await f.pool.query<{
        schema_name: string;
        relation_name: string;
        mutation: string;
      }>(`
      SELECT DISTINCT n.nspname schema_name,c.relname relation_name,
      format('UPDATE %I.%I SET %I=%I WHERE false',n.nspname,c.relname,a.attname,a.attname) mutation
      FROM pg_trigger source JOIN pg_class c ON c.oid=source.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN LATERAL(SELECT attname FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum LIMIT 1) a ON true
      WHERE source.tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure AND NOT source.tgisinternal
      AND source.tgenabled<>'D' AND (source.tgtype&1)=0 AND (source.tgtype&2)=2 AND n.nspname<>'whaleu_media'
      ORDER BY schema_name,relation_name`)
    ).rows;
    assert.equal(
      sources.length,
      12,
      'All twelve currently installed external owner sources are exercised',
    );
    assert.deepEqual(
      [...new Set(sources.map((source) => source.schema_name))].sort(),
      [
        'whaleu_activities',
        'whaleu_announcements',
        'whaleu_organizations',
        'whaleu_school_configuration',
      ],
    );
    const snapshot = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
      'profile',(SELECT to_jsonb(p) FROM whaleu_profile.profiles p WHERE account_id=$1),
      'avatar',whaleu_profile.moderation_avatar_facts($1),
      'commands',(SELECT count(*) FROM whaleu_profile.avatar_moderation_commands),
      'events',(SELECT count(*) FROM whaleu_profile.avatar_moderation_events),
      'notices',(SELECT count(*) FROM whaleu_notifications.profile_avatar_moderation_notices),
      'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM whaleu_media.bindings b),
      'intents',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM whaleu_media.upload_intents i),
      'cleanup',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM whaleu_media.cleanup_obligations c)) value`,
          [subject.accountId],
        )
      ).rows[0]!.value;
    const original = await snapshot();
    // Start with the concrete reported organization scope counterexample, then
    // prove the inventory rather than hard-coding that one relation as a fix.
    sources.sort(
      (a, b) =>
        Number(
          b.schema_name === 'whaleu_organizations' &&
            b.relation_name === 'media_upload_scopes',
        ) -
        Number(
          a.schema_name === 'whaleu_organizations' &&
            a.relation_name === 'media_upload_scopes',
        ),
    );
    for (const source of sources) {
      const originalTransaction = database.transaction,
        run = originalTransaction.bind(database);
      let attempted = false,
        zeroRows = false;
      database.transaction = (work, options) =>
        run(async (tx) => {
          const originalQuery = tx.query;
          const query = originalQuery.bind(tx) as (
            sql: string,
            values?: unknown[],
          ) => Promise<import('pg').QueryResult>;
          tx.query = (async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values);
            if (
              !attempted &&
              sql.startsWith(
                'INSERT INTO whaleu_profile.avatar_moderation_commands',
              )
            ) {
              attempted = true;
              const result = await query(source.mutation);
              zeroRows = result.rowCount === 0;
            }
            return result;
          }) as PoolClient['query'];
          try {
            return await work(tx);
          } finally {
            tx.query = originalQuery;
          }
        }, options);
      let response;
      try {
        response = await f.send(
          admin,
          f.command(target, selected.current.revision, selected.appearanceId),
        );
      } finally {
        database.transaction = originalTransaction;
      }
      assert.equal(
        attempted,
        true,
        `${source.schema_name}.${source.relation_name}: execute after command admission`,
      );
      assert.notEqual(
        response.status,
        200,
        `${source.schema_name}.${source.relation_name}: zeroRows=${zeroRows}; ${JSON.stringify(response.body)}`,
      );
      assert.deepEqual(
        await snapshot(),
        original,
        'Every tentative avatar effect rolls back',
      );
    }
  },
);

test(
  'avatar moderation fails closed for newly installed unguarded epoch sources while cancellation stays session-only',
  { timeout: 180000 },
  async (t) => {
    const f = await profileAvatarModerationFixture(true);
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor();
    const grant = await f.grant(admin),
      selected = await f.custom(subject),
      target = await f.publish(subject);
    const inventory = async () =>
      (
        await f.pool.query<{ valid: boolean }>(
          'SELECT whaleu_profile.avatar_moderation_media_inventory_current() valid',
        )
      ).rows[0]!.valid;
    const body = () =>
      f.command(target, selected.current.revision, selected.appearanceId);
    const base = (command: AvatarModerationCommand) => ({
      requestId: command.clientRequestId,
      target: command.target,
      expectedProfileRevision: command.expectedProfileRevision,
      expectedAppearanceId: command.expectedAppearanceId,
      action: command.action,
    });
    const insert = (
      command: AvatarModerationCommand,
      receipt: object,
      selectedGrant: string | null = grant,
      execute: (sql: string, values: unknown[]) => Promise<unknown> = (
        sql,
        values,
      ) => f.pool.query(sql, values),
    ) =>
      execute(
        `INSERT INTO whaleu_profile.avatar_moderation_commands(actor_id,request_id,session_id,token_hash,target_kind,target_id,intent_hash,command,receipt,grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          admin.accountId,
          command.clientRequestId,
          admin.sessionId,
          hashToken(admin.accessToken),
          command.target.kind,
          command.target.id,
          avatarModerationIntentHash(admin.accountId, command),
          command,
          receipt,
          selectedGrant,
        ],
      );
    assert.equal(await inventory(), true);
    await f.pool
      .query(`CREATE SCHEMA whaleu_avatar_epoch_test;CREATE TABLE whaleu_avatar_epoch_test.bindings(id uuid PRIMARY KEY);
      CREATE TRIGGER a1_test_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_avatar_epoch_test.bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()`);
    try {
      assert.equal(
        await inventory(),
        false,
        'New sources cannot silently enter the authorized mutation set',
      );
      for (const stale of [false, true]) {
        const command = body();
        if (stale) command.expectedProfileRevision = 0;
        const response = await f.send(admin, command);
        assert.equal(response.status, 503, JSON.stringify(response.body));
        assert.equal(
          response.body.error.code,
          'PROFILE_AVATAR_MODERATION_UNAVAILABLE',
        );
        const raw = body();
        if (stale) raw.expectedProfileRevision = 0;
        const receipt = stale
          ? {
              ...base(raw),
              outcome: 'rejected',
              code: 'PROFILE_AVATAR_MODERATION_STALE',
            }
          : {
              ...base(raw),
              outcome: 'applied',
              revision: raw.expectedProfileRevision + 1,
              eventId: randomUUID(),
              recordedAt: new Date().toISOString(),
            };
        await assert.rejects(
          insert(raw, receipt),
          (error) =>
            causal(error) &&
            String((error as Error).message).includes(
              'Every installed Media epoch source',
            ),
        );
      }
      // The session-only cancellation itself still succeeds with an unknown
      // inventory. A later external source mutation in that same transaction
      // must fail, including after all deferred constraints have been flushed.
      for (const mutation of [
        'UPDATE whaleu_organizations.media_upload_scopes SET created_at=created_at WHERE false',
        'UPDATE whaleu_avatar_epoch_test.bindings SET id=id WHERE false',
      ]) {
        const tx = await f.pool.connect(),
          lateCancel = body();
        try {
          await tx.query('BEGIN');
          await insert(
            lateCancel,
            {
              ...base(lateCancel),
              outcome: 'rejected',
              code: 'PROFILE_AVATAR_MODERATION_CANCELLED',
            },
            null,
            (sql, values) => tx.query(sql, values),
          );
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          await assert.rejects(tx.query(mutation), causal);
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_profile.avatar_moderation_commands WHERE actor_id=$1 AND request_id=$2',
              [admin.accountId, lateCancel.clientRequestId],
            )
          ).rowCount,
          0,
          'Cancelled metadata and forbidden late writer roll back together',
        );
      }
      const cancelled = body(),
        response = await f.send(admin, cancelled, true);
      profileOk(response);
      assert.equal(response.body.code, 'PROFILE_AVATAR_MODERATION_CANCELLED');
      const rawCancel = body();
      await insert(
        rawCancel,
        {
          ...base(rawCancel),
          outcome: 'rejected',
          code: 'PROFILE_AVATAR_MODERATION_CANCELLED',
        },
        null,
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::int count FROM whaleu_profile.avatar_moderation_media_statements`,
          )
        ).rows[0]!.count,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::int count FROM whaleu_profile.avatar_moderation_media_epochs`,
          )
        ).rows[0]!.count,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::int count FROM whaleu_profile.avatar_moderation_events`,
          )
        ).rows[0]!.count,
        0,
      );
      // A correctly installed guard satisfies the inventory, but a same-named
      // table in another schema still cannot impersonate a permitted binding.
      await f.pool.query(
        `CREATE TRIGGER a00_avatar_moderation_media_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_avatar_epoch_test.bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.avatar_moderation_media_statement_guard()`,
      );
      assert.equal(await inventory(), true);
      const { DatabaseService } =
        await import('../../src/database/database.js');
      const database = f.moderationApp.get(DatabaseService),
        transaction = database.transaction,
        run = transaction.bind(database);
      let attempted = false;
      database.transaction = (work, options) =>
        run(async (tx) => {
          const original = tx.query,
            query = original.bind(tx) as (
              sql: string,
              values?: unknown[],
            ) => Promise<import('pg').QueryResult>;
          tx.query = (async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values);
            if (
              !attempted &&
              sql.startsWith(
                'INSERT INTO whaleu_profile.avatar_moderation_commands',
              )
            ) {
              attempted = true;
              await query(
                'UPDATE whaleu_avatar_epoch_test.bindings SET id=id WHERE false',
              );
            }
            return result;
          }) as PoolClient['query'];
          try {
            return await work(tx);
          } finally {
            tx.query = original;
          }
        }, options);
      try {
        const result = await f.send(admin, body());
        assert.equal(result.status, 503, JSON.stringify(result.body));
        assert.equal(attempted, true);
      } finally {
        database.transaction = transaction;
      }
    } finally {
      await f.pool.query('DROP SCHEMA whaleu_avatar_epoch_test CASCADE');
    }
    assert.equal(await inventory(), true);
    const applied = await f.apply(target, admin);
    assert.equal(applied.receipt.outcome, 'applied');
    const cause = (
      await f.pool.query<{
        statements: number;
        epochs: number;
        complete: boolean;
      }>(
        `SELECT (SELECT count(*)::int FROM whaleu_profile.avatar_moderation_media_statements s WHERE (s.actor_id,s.request_id)=(q.actor_id,q.request_id)) statements,(SELECT count(*)::int FROM whaleu_profile.avatar_moderation_media_epochs e WHERE (e.actor_id,e.request_id)=(q.actor_id,q.request_id)) epochs,whaleu_profile.avatar_moderation_media_epoch_complete(q) complete FROM whaleu_profile.avatar_moderation_commands q WHERE actor_id=$1 AND request_id=$2`,
        [admin.accountId, applied.body.clientRequestId],
      )
    ).rows[0]!;
    assert.equal(
      cause.statements,
      7,
      'One detach, three cleanup inserts, ingress, intent and quota statements',
    );
    assert.equal(
      cause.epochs,
      cause.statements,
      'Every permitted statement has exactly one real epoch transition',
    );
    assert.equal(cause.complete, true);
  },
);

test(
  'indexed Media trigger inventory equals the published full-catalog predicate through normal PostgreSQL DDL',
  { timeout: 120000 },
  async (t) => {
    const f = await profileAvatarModerationFixture();
    t.after(() => f.close());
    const published = await readFile(
      new URL(
        '../../migrations/0129_scoped_profile_avatar_moderation.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const oracle =
      /CREATE FUNCTION whaleu_profile\.avatar_moderation_media_inventory_current\(\) RETURNS boolean LANGUAGE sql STABLE AS \$\$([\s\S]*?)\$\$;/.exec(
        published,
      )?.[1];
    assert.ok(oracle, 'The oracle is the unchanged published 0129 body');
    const sourceRows = `SELECT source.oid,source.tgrelid,source.tgfoid,source.tgtype,source.tgenabled,source.tgisinternal,source.tgparentid
      FROM pg_catalog.pg_trigger source WHERE source.tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure ORDER BY source.oid`;
    const indexedRows = `SELECT DISTINCT source.oid,source.tgrelid,source.tgfoid,source.tgtype,source.tgenabled,source.tgisinternal,source.tgparentid
      FROM pg_catalog.pg_depend dep JOIN pg_catalog.pg_trigger source ON source.oid=dep.objid
      WHERE dep.classid='pg_catalog.pg_trigger'::regclass AND dep.refclassid='pg_catalog.pg_proc'::regclass
      AND dep.refobjid='whaleu_media.advance_owner_epoch()'::regprocedure
      AND source.tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure ORDER BY source.oid`;
    const check = async (tx: PoolClient, expected: boolean) => {
      const previous = (
        await tx.query<{ valid: boolean }>(`SELECT (${oracle}) valid`)
      ).rows[0]!.valid;
      const current = (
        await tx.query<{ valid: boolean }>(
          'SELECT whaleu_profile.avatar_moderation_media_inventory_current() valid',
        )
      ).rows[0]!.valid;
      assert.equal(previous, expected);
      assert.equal(current, previous);
      assert.deepEqual(
        (await tx.query(indexedRows)).rows,
        (await tx.query(sourceRows)).rows,
      );
    };
    const run = async (work: (tx: PoolClient) => Promise<void>) => {
      const tx = await f.pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query(`CREATE SCHEMA avatar_inventory_spec;
          CREATE TABLE avatar_inventory_spec.target(id integer PRIMARY KEY);
          CREATE FUNCTION avatar_inventory_spec.noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$`);
        await check(tx, true);
        await work(tx);
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
      }
    };
    const source = `CREATE TRIGGER source BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON avatar_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()`;
    const guard = `CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON avatar_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.avatar_moderation_media_statement_guard()`;
    await t.test(
      'all current source owners are exactly discoverable, with no dependency-kind approximation',
      () =>
        run(async (tx) => {
          const rows = (await tx.query(sourceRows)).rows;
          assert.ok(rows.length >= 53);
          await check(tx, true);
        }),
    );
    await t.test(
      'uncovered foreign sources fail for ordinary, replica and always modes; disabled sources preserve the original predicate',
      () =>
        run(async (tx) => {
          await tx.query(source);
          for (const mode of ['ENABLE', 'ENABLE REPLICA', 'ENABLE ALWAYS']) {
            await tx.query(
              `ALTER TABLE avatar_inventory_spec.target ${mode} TRIGGER source`,
            );
            await check(tx, false);
          }
          await tx.query(
            'ALTER TABLE avatar_inventory_spec.target DISABLE TRIGGER source',
          );
          await check(tx, true);
          await tx.query(
            'ALTER TABLE avatar_inventory_spec.target ENABLE TRIGGER source',
          );
          await tx.query(guard);
          for (const mode of ['ENABLE', 'ENABLE ALWAYS']) {
            await tx.query(
              `ALTER TABLE avatar_inventory_spec.target ${mode} TRIGGER guard`,
            );
            await check(tx, true);
          }
          for (const mode of ['DISABLE', 'ENABLE REPLICA']) {
            await tx.query(
              `ALTER TABLE avatar_inventory_spec.target ${mode} TRIGGER guard`,
            );
            await check(tx, false);
          }
          await tx.query('DROP TRIGGER source ON avatar_inventory_spec.target');
          await check(tx, true);
        }),
    );
    await t.test(
      'CREATE OR REPLACE replaces the real function dependency and cannot lend a similarly named guard',
      () =>
        run(async (tx) => {
          await tx.query(
            'CREATE TRIGGER source BEFORE INSERT ON avatar_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION avatar_inventory_spec.noop()',
          );
          await check(tx, true);
          await tx.query(
            'CREATE OR REPLACE TRIGGER source BEFORE INSERT ON avatar_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',
          );
          await check(tx, false);
          await tx.query(
            'CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON avatar_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION avatar_inventory_spec.noop()',
          );
          await check(tx, false);
          await tx.query(
            'CREATE OR REPLACE TRIGGER source BEFORE INSERT ON avatar_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION avatar_inventory_spec.noop()',
          );
          await check(tx, true);
        }),
    );
    await t.test(
      'incomplete operations, WHEN qualifiers and arguments do not become complete guards',
      () =>
        run(async (tx) => {
          await tx.query(source);
          for (const statement of [
            'CREATE TRIGGER guard BEFORE INSERT ON avatar_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.avatar_moderation_media_statement_guard()',
            'CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON avatar_inventory_spec.target FOR EACH STATEMENT WHEN (pg_trigger_depth()>=0) EXECUTE FUNCTION whaleu_profile.avatar_moderation_media_statement_guard()',
            "CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON avatar_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.avatar_moderation_media_statement_guard('unexpected')",
          ]) {
            await tx.query(statement);
            await check(tx, false);
            await tx.query(
              'DROP TRIGGER guard ON avatar_inventory_spec.target',
            );
          }
        }),
    );
    await t.test(
      'row, AFTER and constraint sources remain invalid rather than disappearing from discovery',
      () =>
        run(async (tx) => {
          await tx.query(guard);
          for (const statement of [
            'CREATE TRIGGER source BEFORE INSERT ON avatar_inventory_spec.target FOR EACH ROW EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',
            'CREATE TRIGGER source AFTER INSERT ON avatar_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',
            'CREATE CONSTRAINT TRIGGER source AFTER INSERT ON avatar_inventory_spec.target DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',
          ]) {
            await tx.query(statement);
            await check(tx, false);
            await tx.query(
              'DROP TRIGGER source ON avatar_inventory_spec.target',
            );
          }
        }),
    );
    await t.test(
      'partition row clones retain their actual function dependency and cannot bypass the source type check',
      () =>
        run(async (tx) => {
          await tx.query(`CREATE TABLE avatar_inventory_spec.parent(id integer) PARTITION BY RANGE(id);
        CREATE TABLE avatar_inventory_spec.child PARTITION OF avatar_inventory_spec.parent FOR VALUES FROM(0) TO(10);
        CREATE TRIGGER source BEFORE INSERT ON avatar_inventory_spec.parent FOR EACH ROW EXECUTE FUNCTION whaleu_media.advance_owner_epoch()`);
          assert.equal(
            (
              await tx.query(
                "SELECT 1 FROM pg_trigger WHERE tgrelid='avatar_inventory_spec.child'::regclass AND tgparentid<>0 AND tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure",
              )
            ).rowCount,
            1,
          );
          await check(tx, false);
          await tx.query('DROP TRIGGER source ON avatar_inventory_spec.parent');
          await check(tx, true);
          for (const relation of ['parent', 'child']) {
            await tx.query(
              `CREATE TRIGGER source BEFORE INSERT ON avatar_inventory_spec.${relation} FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()`,
            );
            await check(tx, false);
            await tx.query(
              `CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON avatar_inventory_spec.${relation} FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.avatar_moderation_media_statement_guard()`,
            );
            await check(tx, true);
          }
        }),
    );
    await t.test(
      'internal FK triggers and a function referenced only by WHEN cannot impersonate an epoch source',
      () =>
        run(async (tx) => {
          await tx.query(`CREATE TABLE avatar_inventory_spec.foreign_child(id integer REFERENCES avatar_inventory_spec.target(id));
        CREATE TRIGGER when_reference BEFORE INSERT ON avatar_inventory_spec.target FOR EACH STATEMENT WHEN (whaleu_media.advance_owner_epoch() IS NULL) EXECUTE FUNCTION avatar_inventory_spec.noop()`);
          assert.ok(
            (
              await tx.query(
                "SELECT 1 FROM pg_trigger WHERE tgrelid='avatar_inventory_spec.foreign_child'::regclass AND tgisinternal",
              )
            ).rowCount,
          );
          assert.equal(
            (
              await tx.query(
                "SELECT 1 FROM pg_depend d JOIN pg_trigger g ON g.oid=d.objid WHERE d.classid='pg_trigger'::regclass AND d.refclassid='pg_proc'::regclass AND d.refobjid='whaleu_media.advance_owner_epoch()'::regprocedure AND g.tgname='when_reference' AND g.tgfoid<>'whaleu_media.advance_owner_epoch()'::regprocedure",
              )
            ).rowCount,
            1,
          );
          await check(tx, true);
        }),
    );
    await t.test(
      'bounded inventory plan records actual server/JIT settings without broad trigger scans',
      () =>
        run(async (tx) => {
          const environment = (
            await tx.query(
              `SELECT version() version,pg_jit_available() jit_available,current_setting('jit') jit,current_setting('jit_above_cost') jit_above_cost`,
            )
          ).rows[0];
          const body = (
            await tx.query<{ prosrc: string }>(
              "SELECT prosrc FROM pg_proc WHERE oid='whaleu_profile.avatar_moderation_media_inventory_current()'::regprocedure",
            )
          ).rows[0]!.prosrc;
          await check(tx, true);
          await tx.query(
            "SET LOCAL statement_timeout='100ms';SET LOCAL lock_timeout='1ms'",
          );
          const started = performance.now();
          const result = (
            await tx.query<Record<string, unknown>>(
              'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + body,
            )
          ).rows[0]!['QUERY PLAN'] as Array<Record<string, unknown>>;
          const nodes: Array<Record<string, unknown>> = [];
          const collect = (node: Record<string, unknown>) => {
            nodes.push(node);
            for (const child of (node['Plans'] ?? []) as Array<
              Record<string, unknown>
            >)
              collect(child);
          };
          collect(result[0]!['Plan'] as Record<string, unknown>);
          t.diagnostic(
            JSON.stringify({
              avatarInventoryProofEnvironment: environment,
              avatarInventoryFunctionBodySha256: createHash('sha256')
                .update(body)
                .digest('hex'),
              avatarInventoryPlan: {
                statementBudgetMs: 100,
                clientMs: performance.now() - started,
                planningMs: result[0]!['Planning Time'],
                executionMs: result[0]!['Execution Time'],
                nodes: nodes.map((node) => ({
                  type: node['Node Type'],
                  relation: node['Relation Name'],
                  index: node['Index Name'],
                  loops: node['Actual Loops'],
                  rows: node['Actual Rows'],
                  sharedHits: node['Shared Hit Blocks'],
                })),
              },
            }),
          );
          assert.ok(
            nodes.some(
              (node) => node['Index Name'] === 'pg_depend_reference_index',
            ),
          );
          assert.equal(
            nodes.some(
              (node) =>
                node['Relation Name'] === 'pg_trigger' &&
                node['Node Type'] === 'Seq Scan',
            ),
            false,
          );
        }),
    );
  },
);
