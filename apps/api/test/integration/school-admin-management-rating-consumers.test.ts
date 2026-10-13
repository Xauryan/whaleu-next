import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { ratingCategoryManagementFixture } from '../support/rating-category-management-fixture.js';
import {
  majorDiscussionFixture,
  reviewMajorDiscussion,
} from '../support/major-discussion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import {
  schoolAdminPath,
  type SchoolAdminTestGrant,
} from '../support/school-admin-management-fixture.js';
import {
  schoolAdminManagementSchema,
  schoolAdminManagementReceiptSchema,
} from '../../src/authorization/school-admin-management/contracts.js';

function ok(response: { status: number; body: unknown }) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

function denied(
  response: { status: number; body: { error?: { code?: string } } },
  code: string,
) {
  assert.ok(response.status >= 400, JSON.stringify(response.body));
  assert.equal(response.body.error?.code, code, JSON.stringify(response.body));
}

test(
  'HTTP-issued school grants drive current scoped category mutations and Major deletes; reassignment/revocation deny cached intents without rewriting committed history',
  { timeout: 300000 },
  async (t) => {
    // This accepted fixture creates only its explicitly synthetic super account.
    // The school actor gets no raw role or category-only campus grant at any point.
    const f = await ratingCategoryManagementFixture();
    t.after(() => f.close());
    const majors = await majorDiscussionFixture(f);
    const school = await f.actor({ campusId: f.scope.related.campusId }),
      author = await f.actor(),
      profileId = randomUUID();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'INSERT INTO whaleu_profile.profiles(account_id,public_id) VALUES($1,$2)',
        [school.accountId, profileId],
      ),
    );
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT account_id,role FROM whaleu_authorization.role_grants ORDER BY id',
        )
      ).rows,
      [{ account_id: f.admin.accountId, role: 'super_admin' }],
    );
    const get = (path: string, actor = school) =>
      f.auth(request(f.http).get(path), actor);
    const post = (path: string, body: object, actor = school) =>
      f.auth(request(f.http).post(path), actor).send(body);
    const campus = (campusId: string) => ({
      kind: 'campus' as const,
      campusId,
    });
    const epoch = async () =>
      BigInt(
        (
          await f.pool.query<{ value: string }>(
            'SELECT revision::text value FROM whaleu_majors.major_delete_authority_epoch WHERE singleton',
          )
        ).rows[0]!.value,
      );
    const assignments = async () =>
      (
        await f.pool.query<{ value: SchoolAdminTestGrant }>(
          "SELECT to_jsonb(g) value FROM whaleu_authorization.role_grants g WHERE account_id=$1 AND role='school_admin' ORDER BY created_at,id",
          [school.accountId],
        )
      ).rows.map((row) => row.value);
    const manage = async (
      action: 'appoint' | 'reassign' | 'revoke',
      regionId?: string,
    ) => {
      const response = await get(
        `${schoolAdminPath}/management`,
        f.admin,
      ).query({
        targetProfileId: profileId,
      });
      ok(response);
      const view = schoolAdminManagementSchema.parse(response.body);
      const command = {
        clientRequestId: randomUUID(),
        targetProfileId: profileId,
        expectedStateVersion: view.stateVersion,
        action,
        ...(regionId ? { regionId } : {}),
      };
      const before = await epoch();
      const applied = await post(
        `${schoolAdminPath}/commands`,
        command,
        f.admin,
      );
      ok(applied);
      const receipt = schoolAdminManagementReceiptSchema.parse(applied.body);
      assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
      assert.ok(
        (await epoch()) > before,
        'The real role mutation must advance the existing 0124 authority epoch',
      );
      return { command, receipt };
    };
    const categoryIntent = async (campusId: string, name: string) =>
      f.managementIntent(
        await f.managementContext(school, campus(campusId)),
        'create_categories_scoped',
        {
          parentId: null,
          placement: { kind: 'campuses', campusIds: [campusId] },
          nodes: [{ key: 'root', parentKey: null, name, description: '' }],
        },
      );
    const categoryHistory = async (key: string) =>
      (
        await f.pool.query<{ value: unknown }>(
          `SELECT jsonb_build_object(
            'request',(SELECT to_jsonb(r) FROM whaleu_ratings.requests r WHERE account_id=$1 AND request_id=$2),
            'preparation',(SELECT to_jsonb(p) FROM whaleu_ratings.scoped_command_preparations p WHERE account_id=$1 AND request_id=$2),
            'outcome',(SELECT to_jsonb(o) FROM whaleu_ratings.scoped_command_outcomes o WHERE account_id=$1 AND request_id=$2),
            'causes',(SELECT jsonb_agg(to_jsonb(c) ORDER BY cause_kind,artifact_id) FROM whaleu_ratings.scoped_command_causes c WHERE account_id=$1 AND request_id=$2),
            'release',(SELECT to_jsonb(r) FROM whaleu_ratings.scoped_releases r JOIN whaleu_ratings.scoped_command_causes c ON c.artifact_id=r.id WHERE c.account_id=$1 AND c.request_id=$2 AND c.cause_kind='category_release'),
            'catalogs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM whaleu_ratings.scoped_catalogs r JOIN whaleu_ratings.scoped_command_causes c ON c.artifact_id=r.release_id WHERE c.account_id=$1 AND c.request_id=$2 AND c.cause_kind='category_release')
          ) value`,
          [school.accountId, key],
        )
      ).rows[0]!.value;

    const homeMajor = majors.add({ campusId: f.scope.home.campusId }),
      relatedMajor = majors.add({ campusId: f.scope.related.campusId });
    const catalog = await majors.accept([homeMajor, relatedMajor]);
    await majors.acceptDiscussion([homeMajor.id, relatedMajor.id]);
    const publish = async (major: typeof homeMajor, body: string) => {
      const command = majors.root(catalog, major, body);
      await reviewMajorDiscussion(f.pool, author.accountId, major.id, command);
      const response = await post(
        `/v1/majors/${major.id}/discussion`,
        command,
        author,
      );
      ok(response);
      return {
        majorId: major.id,
        commentId: String(response.body.commentId),
        command: { clientRequestId: randomUUID(), rootId: null },
      };
    };
    const homeDone = await publish(homeMajor, 'Committed home deletion'),
      homePending = await publish(homeMajor, 'Keep after school reassignment'),
      relatedDone = await publish(relatedMajor, 'Committed related deletion'),
      relatedPending = await publish(
        relatedMajor,
        'Keep after school revocation',
      );
    type Removal = typeof homeDone;
    const capability = async (removal: Removal) => {
      const response = await get(
        `/v1/majors/${removal.majorId}/discussion/${removal.commentId}/delete-capability`,
      );
      ok(response);
      return response.body.allowed as boolean;
    };
    const remove = (removal: Removal, command = removal.command) =>
      post(
        `/v1/majors/${removal.majorId}/discussion/${removal.commentId}/delete`,
        command,
      );
    const noRemoval = async (removal: Removal) => {
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_majors.major_discussion_tombstones WHERE comment_id=$1',
            [removal.commentId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_majors.major_discussion_delete_commands WHERE actor_id=$1 AND request_id=$2',
            [school.accountId, removal.command.clientRequestId],
          )
        ).rowCount,
        0,
      );
    };
    const deletionHistory = async (removal: Removal) =>
      (
        await f.pool.query<{ value: unknown }>(
          `SELECT jsonb_build_object(
            'command',(SELECT to_jsonb(c) FROM whaleu_majors.major_discussion_delete_commands c WHERE actor_id=$1 AND request_id=$2),
            'tombstone',(SELECT to_jsonb(t) FROM whaleu_majors.major_discussion_tombstones t WHERE actor_id=$1 AND request_id=$2)
          ) value`,
          [school.accountId, removal.command.clientRequestId],
        )
      ).rows[0]!.value;
    const publicationHistory = async () =>
      (
        await f.pool.query<{ value: unknown }>(
          `SELECT jsonb_build_object(
            'comments',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM whaleu_majors.major_discussion_comments c),
            'commands',(SELECT jsonb_agg(to_jsonb(c) ORDER BY actor_id,request_id) FROM whaleu_majors.major_discussion_commands c),
            'review',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM whaleu_community.major_discussion_review_decisions r)
          ) value`,
        )
      ).rows[0]!.value;
    const originalPublications = await publicationHistory();
    denied(
      await f.managementPost(school, 'contexts', {
        selector: campus(f.campusA),
      }),
      'RATING_SCOPE_UNAVAILABLE',
    );
    assert.equal(await capability(homeDone), false);

    // Observe real queries only; no authority, Review, writer or query result is replaced.
    const observer = observeDirectoryQueries(f.app),
      executed = new Set<string>();
    t.after(() => observer.restore());
    observer.setHook(async ({ sql }) => {
      executed.add(sql);
    });
    const appointment = await manage('appoint', f.scope.home.regionId);
    const [oldGrant] = await assignments();
    assert.ok(oldGrant);
    assert.equal(oldGrant.operating_region_id, f.scope.home.regionId);
    const homeContext = await f.managementContext(school, campus(f.campusA));
    assert.deepEqual(homeContext.campusIds, [f.campusA, f.campusB].sort());
    assert.equal(homeContext.canManageGlobal, false);
    for (const selector of [
      campus(f.scope.related.campusId),
      { kind: 'global' },
    ])
      denied(
        await f.managementPost(school, 'contexts', { selector }),
        'RATING_SCOPE_UNAVAILABLE',
      );
    assert.equal(await capability(relatedDone), false);
    denied(await remove(relatedDone), 'MAJOR_DISCUSSION_NOT_FOUND');
    await noRemoval(relatedDone);

    const firstInput = await categoryIntent(
      f.campusA,
      'Home authority category',
    );
    const firstCategory = await f.executeManagement(school, firstInput);
    assert.deepEqual(firstCategory.prepared.affectedScopeKeys, [
      `campus:${f.campusA}`,
    ]);
    const firstCategoryHistory = await categoryHistory(
      firstInput.payload.clientRequestId,
    );
    const firstDelete = await remove(homeDone);
    ok(firstDelete);
    assert.equal(firstDelete.body.outcome, 'applied');
    const firstDeleteHistory = await deletionHistory(homeDone);
    const firstAuthority = (
      await f.pool.query<{
        authority: {
          kind: string;
          region: string;
          grants: SchoolAdminTestGrant[];
        };
      }>(
        'SELECT authority FROM whaleu_majors.major_discussion_delete_commands WHERE actor_id=$1 AND request_id=$2',
        [school.accountId, homeDone.command.clientRequestId],
      )
    ).rows[0]!.authority;
    assert.equal(firstAuthority.kind, 'administrator');
    assert.equal(firstAuthority.region, f.scope.home.regionId);
    assert.deepEqual(
      firstAuthority.grants.map((grant) => grant.id),
      [oldGrant.id],
    );
    const pendingHome = await categoryIntent(
      f.campusA,
      'Uncommitted old region',
    );
    const preparedHome = await f.prepareManagement(school, pendingHome);
    await f.approveManagement(school, pendingHome);
    assert.equal(await capability(homePending), true);
    const beforeReassign = {
      artifacts: await f.managementArtifacts(),
      ledger: await f.managementLedger(),
    };

    await manage('reassign', f.scope.related.regionId);
    const afterReassign = await assignments(),
      retired = afterReassign.find((grant) => grant.id === oldGrant.id)!,
      replacement = afterReassign.find((grant) => grant.id !== oldGrant.id)!;
    assert.equal(afterReassign.length, 2);
    assert.ok(retired.revoked_at);
    assert.deepEqual(
      {
        ...retired,
        revoked_at: oldGrant.revoked_at,
        revoked_by_account_id: oldGrant.revoked_by_account_id,
      },
      oldGrant,
    );
    assert.equal(replacement.operating_region_id, f.scope.related.regionId);
    assert.equal(replacement.revoked_at, null);
    denied(
      await f.commitManagement(
        school,
        pendingHome,
        preparedHome.contextRevision,
      ),
      'RATING_SCOPE_UNAVAILABLE',
    );
    denied(
      await f.managementPost(school, 'contexts', {
        selector: campus(f.campusA),
      }),
      'RATING_SCOPE_UNAVAILABLE',
    );
    assert.equal(await capability(homePending), false);
    denied(await remove(homePending), 'MAJOR_DISCUSSION_NOT_FOUND');
    await noRemoval(homePending);
    assert.deepEqual(
      {
        artifacts: await f.managementArtifacts(),
        ledger: await f.managementLedger(),
      },
      beforeReassign,
      'A cached reviewed category preparation cannot mutate the old region',
    );
    assert.deepEqual(
      await categoryHistory(firstInput.payload.clientRequestId),
      firstCategoryHistory,
    );
    assert.deepEqual(await deletionHistory(homeDone), firstDeleteHistory);

    const nextContext = await f.managementContext(
      school,
      campus(f.scope.related.campusId),
    );
    assert.deepEqual(nextContext.campusIds, [f.scope.related.campusId]);
    assert.equal(nextContext.canManageGlobal, false);
    const secondInput = await categoryIntent(
      f.scope.related.campusId,
      'New fixed region category',
    );
    const secondCategory = await f.executeManagement(school, secondInput);
    assert.deepEqual(secondCategory.prepared.affectedScopeKeys, [
      `campus:${f.scope.related.campusId}`,
    ]);
    const secondCategoryHistory = await categoryHistory(
      secondInput.payload.clientRequestId,
    );
    const secondDelete = await remove(relatedDone);
    ok(secondDelete);
    assert.equal(secondDelete.body.outcome, 'applied');
    const secondDeleteHistory = await deletionHistory(relatedDone);
    const secondAuthority = (
      await f.pool.query<{
        authority: {
          kind: string;
          region: string;
          grants: SchoolAdminTestGrant[];
        };
      }>(
        'SELECT authority FROM whaleu_majors.major_discussion_delete_commands WHERE actor_id=$1 AND request_id=$2',
        [school.accountId, relatedDone.command.clientRequestId],
      )
    ).rows[0]!.authority;
    assert.equal(secondAuthority.kind, 'administrator');
    assert.equal(secondAuthority.region, f.scope.related.regionId);
    assert.deepEqual(
      secondAuthority.grants.map((grant) => grant.id),
      [replacement.id],
    );
    const pendingRelated = await categoryIntent(
      f.scope.related.campusId,
      'Uncommitted revoked authority',
    );
    const preparedRelated = await f.prepareManagement(school, pendingRelated);
    await f.approveManagement(school, pendingRelated);
    assert.equal(await capability(relatedPending), true);
    const beforeRevoke = {
      artifacts: await f.managementArtifacts(),
      ledger: await f.managementLedger(),
    };
    await manage('revoke');
    assert.ok(
      (await assignments()).every((grant) => grant.revoked_at !== null),
    );
    denied(
      await f.commitManagement(
        school,
        pendingRelated,
        preparedRelated.contextRevision,
      ),
      'RATING_SCOPE_UNAVAILABLE',
    );
    // Fresh keys also fail. Old preparations and displayed capabilities cannot
    // grant current authority, while original successful keys remain recoverable.
    denied(
      await f.managementPost(school, 'prepare', {
        ...pendingRelated,
        payload: { ...pendingRelated.payload, clientRequestId: randomUUID() },
      }),
      'RATING_SCOPE_UNAVAILABLE',
    );
    assert.equal(await capability(relatedPending), false);
    denied(await remove(relatedPending), 'MAJOR_DISCUSSION_NOT_FOUND');
    denied(
      await remove(relatedPending, {
        clientRequestId: randomUUID(),
        rootId: null,
      }),
      'MAJOR_DISCUSSION_NOT_FOUND',
    );
    await noRemoval(relatedPending);
    assert.deepEqual(
      {
        artifacts: await f.managementArtifacts(),
        ledger: await f.managementLedger(),
      },
      beforeRevoke,
    );
    for (const [input, result] of [
      [firstInput, firstCategory],
      [secondInput, secondCategory],
    ] as const) {
      const recovered = await get(
        `/v2/ratings/requests/${input.payload.clientRequestId}`,
      );
      ok(recovered);
      assert.deepEqual(recovered.body, result.receipt);
      const replayed = await f.commitManagement(
        school,
        input,
        result.prepared.contextRevision,
      );
      ok(replayed);
      assert.deepEqual(replayed.body, result.receipt);
    }
    for (const [removal, receipt] of [
      [homeDone, firstDelete.body],
      [relatedDone, secondDelete.body],
    ] as const) {
      const recovered = await get(
        `/v1/majors/discussion-delete-requests/${removal.command.clientRequestId}`,
      );
      ok(recovered);
      assert.deepEqual(recovered.body, receipt);
      const replayed = await remove(removal);
      ok(replayed);
      assert.deepEqual(replayed.body, receipt);
    }
    assert.deepEqual(
      await categoryHistory(firstInput.payload.clientRequestId),
      firstCategoryHistory,
    );
    assert.deepEqual(
      await categoryHistory(secondInput.payload.clientRequestId),
      secondCategoryHistory,
    );
    assert.deepEqual(await deletionHistory(homeDone), firstDeleteHistory);
    assert.deepEqual(await deletionHistory(relatedDone), secondDeleteHistory);
    assert.deepEqual(await publicationHistory(), originalPublications);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_authorization.rating_category_campus_grants',
        )
      ).rowCount,
      0,
      'Separate category-only grants were never used to disguise school authority',
    );
    assert.ok(
      [...executed].some((sql) => sql.includes("'category_release'")),
      'A real scoped category release cause must be persisted',
    );
    assert.ok(
      [...executed].some((sql) =>
        sql.includes('rating_category_campus_grants IN SHARE MODE NOWAIT'),
      ),
      'The category owner required final role/campus-grant fence must execute',
    );
    assert.ok(
      [...executed].some((sql) =>
        sql.includes('INSERT INTO whaleu_majors.major_discussion_tombstones'),
      ),
    );
    assert.ok(executed.has('SELECT whaleu_majors.major_delete_fence($1)'));
    const recoveredAppointment = await get(
      `${schoolAdminPath}/requests/${appointment.command.clientRequestId}`,
      f.admin,
    );
    ok(recoveredAppointment);
    assert.deepEqual(recoveredAppointment.body, {
      state: 'recorded',
      receipt: appointment.receipt,
    });
  },
);
