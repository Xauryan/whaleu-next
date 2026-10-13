/** Disposable actual HTTP/AppModule; punishment created only through a live
 * source deletion v2 command. Never insert fake ledger/decision/notice rows. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPostRemovalFixture } from './admin-post-removal-fixture.js';
import { profileOk } from './media/profile-runtime-fixture.js';
import {
  appealSubmitReceiptSchema,
  appealManagementViewSchema,
  appealViewSchema,
  punishmentReferenceSchema,
} from '../../src/safety/account-moderation/contracts.js';
import type {
  AppealSubmitCommand,
  AppealDecisionCommand,
  PunishmentKind,
  PunishmentReference,
} from '../../src/safety/account-moderation/contracts.js';
export const ownAppealPath = '/v1/me/safety';
export const adminAppealPath = '/v1/safety/appeal-management';
export async function accountAppealsFixture() {
  const f = await adminPostRemovalFixture();
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  type Post = Awaited<ReturnType<typeof f.publish>>;
  const get = (actor: Actor, path: string) =>
    request(f.http)
      .get(path)
      .set('Authorization', `Bearer ${actor.accessToken}`);
  const send = (
    actor: Actor,
    command: AppealSubmitCommand | AppealDecisionCommand,
    cancel = false,
  ) =>
    request(f.http)
      .post(
        `${command.action === 'submit_appeal' ? ownAppealPath + '/appeal-commands' : adminAppealPath + '/commands'}${cancel ? '/cancel' : ''}`,
      )
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(command);
  const issue = async (
    admin: Actor,
    subject: Actor,
    post: Post,
    kind: PunishmentKind,
    expectedRevision = '0',
  ) => {
    const view = await f.removalManagement(post, admin);
    const command = {
      ...f.removalCommand(post, view.targetVersion),
      version: 2,
      punishment: {
        kind,
        duration: { kind: 'finite', unit: 'hours', value: 2 },
        reason: 'Synthetic private appeal punishment',
        expectedRevision,
      },
    };
    const response = await request(f.http)
      .post('/v1/community/admin-post-removal/commands')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send(command);
    profileOk(response);
    assert.equal(
      response.body.outcome,
      'applied',
      JSON.stringify(response.body),
    );
    const row = (
      await f.pool.query<{
        id: string;
        kind: PunishmentKind;
        revision: string;
      }>(
        'SELECT id,kind,revision::text FROM whaleu_safety.account_punishments WHERE actor_id=$1 AND request_id=$2 AND subject_id=$3',
        [admin.accountId, command.clientRequestId, subject.accountId],
      )
    ).rows[0];
    assert.ok(row, 'Causal live deletion must create the actual punishment');
    return punishmentReferenceSchema.parse({
      punishmentId: row.id,
      kind: row.kind,
      revision: row.revision,
    });
  };
  const submitCommand = (
    punishment: PunishmentReference,
  ): AppealSubmitCommand => ({
    clientRequestId: randomUUID(),
    action: 'submit_appeal',
    punishment,
    text: '请复核处罚。<script>literal text</script>\n私密证据。',
  });
  const submit = async (actor: Actor, punishment: PunishmentReference) => {
    const command = submitCommand(punishment),
      response = await send(actor, command);
    profileOk(response);
    const receipt = appealSubmitReceiptSchema.parse(response.body);
    assert.equal(receipt.outcome, 'applied');
    if (receipt.outcome !== 'applied')
      throw new Error('Expected applied submission');
    return { command, receipt };
  };
  const detail = async (actor: Actor, appealId: string, admin = false) => {
    const response = await get(
      actor,
      `${admin ? adminAppealPath : ownAppealPath}/appeals/${appealId}`,
    );
    profileOk(response);
    return admin
      ? appealManagementViewSchema.parse(response.body)
      : appealViewSchema.parse(response.body);
  };
  const decision = async (
    admin: Actor,
    appealId: string,
    outcome: AppealDecisionCommand['decision'],
  ): Promise<AppealDecisionCommand> => {
    const response = await get(admin, `${adminAppealPath}/appeals/${appealId}`);
    profileOk(response);
    const view = appealManagementViewSchema.parse(response.body);
    return {
      clientRequestId: randomUUID(),
      action: 'decide_appeal',
      appealId,
      expectedStateVersion: view.stateVersion,
      decision: outcome,
      reason: 'Synthetic private review result',
    };
  };
  return { ...f, get, send, issue, submitCommand, submit, detail, decision };
}
