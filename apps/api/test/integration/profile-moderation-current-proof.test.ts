/** Original read facts and independent strict source scalars, with no source-trigger bypass. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { exactObjectSchema } from '../../src/media/contracts.js';
import { textSchema } from '../../src/community/text.js';
import { moderationReceiptSchema } from '../../src/profile/moderation/contracts.js';
import type { ModerationCommand } from '../../src/profile/moderation/contracts.js';
import { profileModerationFixture } from '../support/profile-moderation-fixture.js';
import {
  insertSyntheticAssertion,
  syntheticAssertion,
} from '../support/verification-fixtures.js';

const ok = (response: { status: number; body: unknown }, status = 200) =>
  assert.equal(response.status, status, JSON.stringify(response.body));

test(
  'nickname management retains the displayed original row and strict source/notice invariants',
  { timeout: 180000 },
  async (t) => {
    const f = await profileModerationFixture();
    t.after(() => f.close());
    const http = f.app.getHttpServer(),
      database = f.app.get(DatabaseService);
    const admin = await f.actor(),
      subject = await f.actor();
    const selectedGrant = await f.grant(
      admin.accountId,
      'school_admin',
      f.scope.home.regionId,
    );
    const post = await f.publish(subject),
      target = { kind: 'post' as const, id: post.id };
    const profile = async () =>
      (
        await f.pool.query<{
          nickname: string | null;
          revision: number;
          bytes: object;
        }>(
          'SELECT nickname,revision,to_jsonb(p) bytes FROM whaleu_profile.profiles p WHERE account_id=$1',
          [subject.accountId],
        )
      ).rows[0]!;
    const totals = async () =>
      (
        await f.pool.query(`SELECT
    (SELECT count(*)::integer FROM whaleu_profile.moderation_commands) commands,
    (SELECT count(*)::integer FROM whaleu_profile.moderation_events) events,
    (SELECT count(*)::integer FROM whaleu_profile.moderation_transitions) transitions,
    (SELECT count(*)::integer FROM whaleu_notifications.profile_moderation_notices) notices`)
      ).rows[0];
    const command = async (): Promise<ModerationCommand> => ({
      clientRequestId: randomUUID(),
      target,
      expectedProfileRevision: (await profile()).revision,
      action: 'reset_nickname',
    });
    const send = (body: ModerationCommand) =>
      request(http)
        .post('/v1/community/profile-moderation/commands')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(body);

    await t.test(
      'management and command do not rebase an original Profile row after same-transaction mutation or ABA',
      async () => {
        for (const operation of ['management', 'command'] as const) {
          for (const aba of [false, true]) {
            const own = await profile(),
              before = await totals(),
              body = await command();
            const original = database.transaction,
              execute = original.bind(database);
            let injected = false;
            database.transaction = (work, options) =>
              execute(async (tx) => {
                const originalQuery = tx.query;
                const query = originalQuery.bind(tx) as (
                  sql: string,
                  values?: unknown[],
                ) => Promise<QueryResult>;
                tx.query = (async (sql: string, values?: unknown[]) => {
                  const result = await query(sql, values);
                  if (
                    !injected &&
                    sql.startsWith('SELECT revision,coalesce(nickname,') &&
                    sql.includes('fingerprint') &&
                    values?.[0] === subject.accountId
                  ) {
                    injected = true;
                    assert.equal(result.rows[0]?.revision, own.revision);
                    await query(
                      "UPDATE whaleu_profile.profiles SET nickname='InjectedBeforeProof' WHERE account_id=$1",
                      [subject.accountId],
                    );
                    if (aba)
                      await query(
                        'UPDATE whaleu_profile.profiles SET nickname=$2 WHERE account_id=$1',
                        [subject.accountId, own.nickname],
                      );
                  }
                  return result;
                }) as PoolClient['query'];
                try {
                  return await work(tx);
                } finally {
                  tx.query = originalQuery;
                }
              }, options);
            let result;
            try {
              result =
                operation === 'management'
                  ? await request(http)
                      .get('/v1/community/profile-moderation/management')
                      .set('Authorization', `Bearer ${admin.accessToken}`)
                      .query(target)
                  : await send(body);
            } finally {
              database.transaction = original;
            }
            assert.equal(
              injected,
              true,
              'Mutation occurs after the actual original SELECT returned and before owner enrollment',
            );
            assert.ok(
              result.status >= 400,
              `${operation} ${aba ? 'ABA' : 'replacement'}: ${JSON.stringify(result.body)}`,
            );
            assert.deepEqual(
              await profile(),
              own,
              'No injected raw Profile change can escape the failed transaction',
            );
            assert.deepEqual(await totals(), before);
          }
        }
      },
    );

    await t.test(
      'API stale command preserves its original Profile fact after receipt INSERT and before proof enrollment',
      async () => {
        const initial = await profile();
        const edited = await request(http)
          .patch('/v1/me/profile')
          .set('Authorization', `Bearer ${subject.accessToken}`)
          .send({
            expectedRevision: initial.revision,
            bio: 'Owner edit makes old moderation genuinely stale',
          });
        ok(edited);
        const own = await profile();
        assert.equal(own.revision, initial.revision + 1);
        for (const alteration of ['noop', 'aba'] as const) {
          const body: ModerationCommand = {
            ...(await command()),
            expectedProfileRevision: initial.revision,
          };
          const before = await totals(),
            original = database.transaction,
            execute = original.bind(database);
          let injected = false;
          database.transaction = (work, options) =>
            execute(async (tx) => {
              const originalQuery = tx.query;
              const query = originalQuery.bind(tx) as (
                sql: string,
                values?: unknown[],
              ) => Promise<QueryResult>;
              tx.query = (async (sql: string, values?: unknown[]) => {
                const result = await query(sql, values);
                if (
                  !injected &&
                  sql.includes(
                    'INSERT INTO whaleu_profile.moderation_commands',
                  ) &&
                  values?.[1] === body.clientRequestId
                ) {
                  const recorded = (
                    await query(
                      'SELECT receipt FROM whaleu_profile.moderation_commands WHERE actor_id=$1 AND request_id=$2',
                      [admin.accountId, body.clientRequestId],
                    )
                  ).rows[0];
                  assert.equal(
                    recorded?.receipt?.code,
                    'PROFILE_MODERATION_STALE',
                  );
                  injected = true;
                  if (alteration === 'noop') {
                    const updated = await query(
                      'UPDATE whaleu_profile.profiles SET nickname=nickname WHERE account_id=$1',
                      [subject.accountId],
                    );
                    assert.equal(updated.rowCount, 1);
                  } else {
                    await query(
                      "UPDATE whaleu_profile.profiles SET nickname='TemporaryStaleName' WHERE account_id=$1",
                      [subject.accountId],
                    );
                    await query(
                      'UPDATE whaleu_profile.profiles SET nickname=$2 WHERE account_id=$1',
                      [subject.accountId, own.nickname],
                    );
                  }
                  assert.deepEqual(
                    (
                      await query(
                        'SELECT to_jsonb(p) bytes FROM whaleu_profile.profiles p WHERE account_id=$1',
                        [subject.accountId],
                      )
                    ).rows[0]!.bytes,
                    own.bytes,
                  );
                }
                return result;
              }) as PoolClient['query'];
              try {
                return await work(tx);
              } finally {
                tx.query = originalQuery;
              }
            }, options);
          let result;
          try {
            result = await send(body);
          } finally {
            database.transaction = original;
          }
          assert.equal(
            injected,
            true,
            'A legitimately stale receipt reached INSERT before the adversarial tuple mutation',
          );
          ok(result, 503);
          assert.equal(
            result.body.error.code,
            'PROFILE_MODERATION_UNAVAILABLE',
          );
          assert.deepEqual(await profile(), own);
          assert.deepEqual(await totals(), before);
          const recovered = await request(http)
            .get(
              `/v1/community/profile-moderation/requests/${body.clientRequestId}`,
            )
            .set('Authorization', `Bearer ${admin.accessToken}`);
          ok(recovered);
          assert.deepEqual(recovered.body, { state: 'not_recorded' });
        }
      },
    );

    await t.test(
      'management and commands retain original phone and selected grant facts across pre-enrollment changes',
      async () => {
        const sourceEvidence = async () =>
          (
            await f.pool.query<{ value: object }>(
              `SELECT jsonb_build_object(
          'grant',(SELECT to_jsonb(g) FROM whaleu_authorization.role_grants g WHERE g.id=$2),
          'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM whaleu_authorization.role_grants g WHERE g.account_id=$1),
          'head',(SELECT to_jsonb(h) FROM whaleu_verification.account_heads h WHERE h.account_id=$1),
          'assertions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM whaleu_verification.assertions a WHERE a.account_id=$1),
          'snapshots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM whaleu_verification.snapshots s WHERE s.account_id=$1),
          'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM whaleu_verification.events e WHERE e.account_id=$1)
        ) value`,
              [admin.accountId, selectedGrant],
            )
          ).rows[0]!.value;
        const appendPhone = async (
          tx: PoolClient,
          state: 'verified' | 'unverified',
          reuse?: string,
        ) => {
          const previous = (
            await tx.query<{
              revision: number;
              affiliation_assertion_id: string | null;
              student_number_assertion_id: string | null;
              phone_assertion_id: string | null;
              application_state: string;
              application_coverage: string;
            }>(
              `SELECT h.revision,s.affiliation_assertion_id,s.student_number_assertion_id,s.phone_assertion_id,s.application_state,s.application_coverage
              FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1 FOR UPDATE OF h`,
              [admin.accountId],
            )
          ).rows[0]!;
          const assertion = syntheticAssertion(
            admin.accountId,
            f.scope.institutionId,
            'phone',
            { assertion_state: state },
          );
          if (!reuse) await insertSyntheticAssertion(tx, assertion);
          const phoneId = reuse ?? assertion.id,
            snapshotId = randomUUID(),
            revision = previous.revision + 1;
          await tx.query(
            `INSERT INTO whaleu_verification.snapshots
            (id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              snapshotId,
              admin.accountId,
              revision,
              previous.affiliation_assertion_id,
              previous.student_number_assertion_id,
              phoneId,
              previous.application_state,
              previous.application_coverage,
            ],
          );
          await tx.query(
            `INSERT INTO whaleu_verification.events
            (id,account_id,operation_id,kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code)
            VALUES($1,$2,$3,'reconciled_snapshot',$2,$4,$5,$6,'synthetic_capture_adversary')`,
            [
              randomUUID(),
              admin.accountId,
              randomUUID(),
              previous.revision,
              snapshotId,
              revision,
            ],
          );
          await tx.query(
            'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1',
            [admin.accountId, revision, snapshotId],
          );
          return previous.phone_assertion_id;
        };
        for (const operation of ['management', 'command'] as const) {
          for (const change of [
            'phone-unverified',
            'phone-valid-replacement',
            'phone-semantic-aba',
            'grant-revoked',
            'grant-valid-replacement',
            'grant-valid-tuple-aba',
          ] as const) {
            const original = database.transaction,
              execute = original.bind(database);
            const beforeEvidence = await sourceEvidence(),
              before = await totals(),
              own = await profile(),
              body = await command();
            let injected = false;
            database.transaction = (work, options) =>
              execute(async (tx) => {
                const originalQuery = tx.query;
                const query = originalQuery.bind(tx) as (
                  sql: string,
                  values?: unknown[],
                ) => Promise<QueryResult>;
                tx.query = (async (sql: string, values?: unknown[]) => {
                  const result = await query(sql, values);
                  if (
                    !injected &&
                    /^SELECT\s+id\b/.test(sql.trimStart()) &&
                    sql.includes('moderation_grant_allowed') &&
                    sql.includes('LIMIT 1 FOR SHARE')
                  ) {
                    injected = true;
                    assert.equal(
                      result.rows[0]?.id,
                      selectedGrant,
                      'Definitive selected grant is read before this mutation',
                    );
                    if (change === 'phone-unverified')
                      await appendPhone(tx, 'unverified');
                    else if (change === 'phone-valid-replacement')
                      await appendPhone(tx, 'verified');
                    else if (change === 'phone-semantic-aba') {
                      const originalPhone = await appendPhone(tx, 'unverified');
                      assert.ok(originalPhone);
                      await appendPhone(tx, 'verified', originalPhone);
                    } else if (change === 'grant-valid-tuple-aba') {
                      // The source forbids reverting revocation or changing grant
                      // definitions. Two legal no-op tuple rewrites exercise the
                      // original tuple identity without disabling those guards.
                      for (let index = 0; index < 2; index++) {
                        const rewritten = await query(
                          'UPDATE whaleu_authorization.role_grants SET revoked_at=revoked_at,revoked_by_account_id=revoked_by_account_id WHERE id=$1',
                          [selectedGrant],
                        );
                        assert.equal(rewritten.rowCount, 1);
                      }
                    } else {
                      await query(
                        'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
                        [selectedGrant, admin.accountId],
                      );
                      if (change === 'grant-valid-replacement')
                        await query(
                          `INSERT INTO whaleu_authorization.role_grants
                      (id,account_id,role,operating_region_id,approved_by_account_id,approval_reference)
                      VALUES($1,$2,'school_admin',$3,$2,'synthetic:capture-valid-replacement')`,
                          [
                            randomUUID(),
                            admin.accountId,
                            f.scope.home.regionId,
                          ],
                        );
                    }
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
              response =
                operation === 'management'
                  ? await request(http)
                      .get('/v1/community/profile-moderation/management')
                      .set('Authorization', `Bearer ${admin.accessToken}`)
                      .query(target)
                  : await send(body);
            } finally {
              database.transaction = original;
            }
            assert.equal(
              injected,
              true,
              `${operation}/${change}: test reaches original source capture boundary`,
            );
            assert.ok(
              response.status >= 400,
              `${operation}/${change}: ${JSON.stringify(response.body)}`,
            );
            assert.deepEqual(
              await sourceEvidence(),
              beforeEvidence,
              'Original grant and complete verification evidence survive rollback',
            );
            assert.deepEqual(await totals(), before);
            assert.deepEqual(await profile(), own);
          }
        }
      },
    );

    await t.test(
      'strict scope shape accepts canonical persisted source and rejects extra/missing keys and lax UUID casts',
      async () => {
        const scope = (
          await f.pool.query<{ scope: Record<string, unknown> }>(
            "SELECT scope FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=$1",
            [post.id],
          )
        ).rows[0]!.scope;
        const valid = async (value: unknown) =>
          (
            await f.pool.query<{ allowed: boolean }>(
              'SELECT whaleu_community.profile_moderation_scope_valid($1::jsonb) allowed',
              [JSON.stringify(value)],
            )
          ).rows[0]!.allowed;
        assert.equal(await valid(scope), true);
        for (const key of Object.keys(scope)) {
          const missing = { ...scope };
          delete missing[key];
          assert.equal(await valid(missing), false, `Missing ${key}`);
        }
        for (const patch of [
          { extra: true },
          { sync: 'related' },
          { sync: null },
          { originalSpaceId: null },
          { originalRegionId: 7 },
          { topologySnapshotId: {} },
          { originalSpaceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          { originalSpaceId: 'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa' },
          { affiliationAssertionId: 'aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa' },
          { identitySelectionId: 'not-a-uuid' },
        ])
          assert.equal(await valid({ ...scope, ...patch }), false);
        for (const value of [[], ['none'], 1, 'none'])
          assert.equal(await valid(value), false);
        const emptyOptional = Object.fromEntries(
          Object.keys(scope).map((key) => [
            key,
            key === 'sync'
              ? 'none'
              : key === 'originalSpaceId'
                ? post.input.spaceId
                : null,
          ]),
        );
        assert.equal(
          await valid(emptyOptional),
          true,
          'Nullable source facts stay nullable; target admission separately requires exact regional scope',
        );
      },
    );

    await t.test(
      'SQL trim/text/object-locator boundaries match the canonical JS validators',
      async () => {
        const whitespace =
          '\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
        for (const value of [
          whitespace,
          `${whitespace}Accepted${whitespace}`,
          '\u200Bnot-trimmed\u200B',
          '  A B  ',
        ])
          assert.equal(
            (
              await f.pool.query<{ value: string }>(
                'SELECT whaleu_profile.moderation_trim($1) value',
                [value],
              )
            ).rows[0]!.value,
            value.trim(),
          );
        for (const value of [
          'valid',
          'A\tB\nC',
          '\u0001',
          '\u007F',
          '\u0080',
          '😀'.repeat(255),
          '😀'.repeat(256),
        ])
          assert.equal(
            (
              await f.pool.query<{ valid: boolean }>(
                'SELECT whaleu_profile.moderation_text_valid($1,255) valid',
                [value],
              )
            ).rows[0]!.valid,
            textSchema(255).safeParse(value).success,
          );
        const locator = {
          provider: 'synthetic',
          environment: 'test',
          bucket: 'test.bucket',
          key: 'image/accepted',
          version: 'v1',
        };
        const cases = [
          locator,
          { ...locator, key: '😀'.repeat(512) },
          { ...locator, key: '😀'.repeat(513) },
          { ...locator, key: '😀'.repeat(1024) },
          { ...locator, key: '😀'.repeat(1025) },
          { ...locator, version: '😀'.repeat(1024) },
          { ...locator, version: '😀'.repeat(1025) },
          { ...locator, key: '' },
          { ...locator, key: 'a\u001Fb' },
          { ...locator, version: 'a\u007Fb' },
          { ...locator, provider: 'Upper' },
          { ...locator, environment: '-invalid' },
          { ...locator, bucket: '/invalid' },
          { ...locator, version: 7 },
          { ...locator, key: null },
          { ...locator, unexpected: 'field' },
          { ...locator, key: 'a'.repeat(1024) },
          { ...locator, key: 'a'.repeat(1025) },
          {
            provider: locator.provider,
            environment: locator.environment,
            bucket: locator.bucket,
            key: locator.key,
          },
        ];
        for (const value of cases)
          assert.equal(
            (
              await f.pool.query<{ valid: boolean }>(
                'SELECT whaleu_media.profile_moderation_locator_valid($1::jsonb) valid',
                [JSON.stringify(value)],
              )
            ).rows[0]!.valid,
            exactObjectSchema.safeParse(value).success,
            JSON.stringify(value).slice(0, 160),
          );
      },
    );

    await t.test(
      'canonical poll, formation and trading envelopes reconstruct exactly; raw duplicate/legacy component scalars stay unavailable',
      async () => {
        const poll = await f.publish(subject, {
          component: {
            kind: 'poll',
            question: 'Question',
            selectionMode: 'single',
            options: [' First ', 'Second', '吃瓜🍉'],
          },
        });
        const formation = await f.publish(subject, {
          component: {
            kind: 'formation',
            capacity: 3,
            theme: 'Theme',
            contacts: { wechat: 'synthetic', qq: '', phone: '' },
            contactSharing: 'members_v1',
          },
        });
        const trading = await f.publish(subject, {
          category: 'trading',
          trading: {
            subtype: 'shuma',
            price: '12.50',
            urgency: 'urgent',
            location: 'Synthetic',
            contacts: { wechat: 'synthetic', qq: '', phone: '' },
          },
        });
        for (const published of [post, poll, formation, trading]) {
          const row = (
            await f.pool.query<{ definition: unknown; envelope: unknown }>(
              "SELECT whaleu_community.profile_moderation_definition('post',b.content_id,b.scope) definition,b.envelope FROM whaleu_community.content_approval_bindings b WHERE b.content_kind='post' AND b.content_id=$1",
              [published.id],
            )
          ).rows[0]!;
          assert.deepEqual(row.definition, row.envelope);
        }
        const scope = (
          await f.pool.query<{ scope: object }>(
            "SELECT scope FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=$1",
            [post.id],
          )
        ).rows[0]!.scope;
        const candidateParent = async (
          tx: PoolClient,
          category: 'discussion' | 'trading',
        ) => {
          const id = randomUUID();
          // A transient unbound candidate lets the pure reconstruction inspect
          // raw scalars. Existing approved-component and all other source guards
          // stay enabled. The candidate is never approved or committed.
          await tx.query(
            `INSERT INTO whaleu_community.posts
            (id,space_id,account_id,category,text,author_mode,comments_policy)
            VALUES($1,$2,$3,$4,'Synthetic unbound source candidate','named','open')`,
            [id, f.scope.home.spaceId, subject.accountId, category],
          );
          return id;
        };
        for (const labels of [
          ['Same', ' Same\t'],
          ['First', '吃瓜🍉'],
          ['吃瓜🍉', 'First', 'Second'],
          ['First', ' \uFEFF'],
        ]) {
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            const id = randomUUID(),
              candidate = await candidateParent(tx, 'discussion');
            await tx.query(
              "INSERT INTO whaleu_community.polls(id,post_id,question,selection_mode) VALUES($1,$2,'Synthetic raw candidate','single')",
              [id, candidate],
            );
            for (const [position, label] of labels.entries())
              await tx.query(
                'INSERT INTO whaleu_community.poll_options(id,poll_id,position,label) VALUES($1,$2,$3,$4)',
                [randomUUID(), id, position, label],
              );
            const result = (
              await tx.query<{ definition: unknown }>(
                "SELECT whaleu_community.profile_moderation_definition('post',$1,$2::jsonb) definition",
                [candidate, scope],
              )
            ).rows[0]!;
            assert.equal(result.definition, null, JSON.stringify(labels));
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        }
        const tx = await f.pool.connect();
        try {
          await tx.query('BEGIN');
          const candidate = await candidateParent(tx, 'trading');
          await tx.query(
            "INSERT INTO whaleu_community.trading_listings(post_id,subtype,price,legacy_raw_price,urgency,location,wechat,qq,phone) VALUES($1,'shuma',12.5,'unaccepted historical scalar','urgent','Synthetic','synthetic','','')",
            [candidate],
          );
          assert.equal(
            (
              await tx.query<{ definition: unknown }>(
                "SELECT whaleu_community.profile_moderation_definition('post',$1,$2::jsonb) definition",
                [candidate, scope],
              )
            ).rows[0]!.definition,
            null,
          );
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
      },
    );

    await t.test(
      'early SET CONSTRAINTS cannot mark a fresh notice read in its creation transaction',
      async () => {
        const body = await command(),
          own = await profile(),
          before = await totals();
        const original = database.transaction,
          execute = original.bind(database);
        let injected = false;
        database.transaction = (work, options) =>
          execute(async (tx) => {
            const result = await work(tx),
              parsed = moderationReceiptSchema.safeParse(result);
            if (
              parsed.success &&
              parsed.data.requestId === body.clientRequestId &&
              parsed.data.outcome === 'applied'
            ) {
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              injected = true;
              await tx.query(
                "UPDATE whaleu_notifications.profile_moderation_notices SET read_at=date_trunc('milliseconds',clock_timestamp()) WHERE event_id=$1",
                [parsed.data.eventId],
              );
            }
            return result;
          }, options);
        let result;
        try {
          result = await send(body);
        } finally {
          database.transaction = original;
        }
        assert.equal(injected, true);
        assert.ok(result.status >= 400, JSON.stringify(result.body));
        assert.deepEqual(await profile(), own);
        assert.deepEqual(await totals(), before);
        const applied = await send(body);
        ok(applied);
        assert.equal(applied.body.outcome, 'applied');
        const notice = (
          await f.pool.query<{ id: string; read_at: Date | null }>(
            'SELECT id,read_at FROM whaleu_notifications.profile_moderation_notices WHERE event_id=$1',
            [applied.body.eventId],
          )
        ).rows[0]!;
        assert.equal(notice.read_at, null);
        const read = await request(http)
          .put(`/v1/me/system-notices/${notice.id}/read`)
          .set('Authorization', `Bearer ${subject.accessToken}`)
          .send({});
        ok(read);
        assert.ok(read.body.readAt);
        assert.equal(read.body.unreadCount, 0);
      },
    );
  },
);
