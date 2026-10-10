import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intent as legacyIntent } from './ratings-helpers';
import { replyIntent } from './ratings-r2a-helpers';
import { subscriptionIntent } from './ratings-r2c-helpers';
import { adminIntent } from './ratings-r3a-helpers';
import { creationIntent } from './ratings-management-helpers';
import { ownerIntent } from './rating-owner-management-helpers';
import { editingIntent } from './rating-owner-editing-helpers';
import { categoryCreationIntent } from './category-management-helpers';
import { managementIntent } from './category-scoped-helpers';
import { scopedIntent } from './rating-scoped-helpers';
import { wireCredentials, accountId } from './identity-helpers';
import {
  requestId,
  otherId,
  targetId,
  categoryId,
  timestamp,
} from './ratings-helpers';
import {
  decodeRatingTargetCoverIntent,
  ratingTargetCoverIntentHash,
} from '../src/ratings/target-cover-contract';
import { ratingCoverScopeIdentity } from '../src/ratings/target-cover-upload-scope';
import {
  RATINGS_MEDIA_PROTOCOL,
  ratingCoverPrepareHash,
} from '../src/ratings/target-cover-media-contract';
test('separate native processes recover journal11 at every durable business boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rating-cover-process-'));
  const previous = scopedIntent('create_target_scoped');
  const intent = decodeRatingTargetCoverIntent({
    protocolVersion: 3,
    operation: previous.operation,
    context: previous.context,
    payload: {
      clientRequestId: requestId,
      categoryId,
      expectedCategoryRevision: previous.payload.expectedCategoryRevision,
      name: 'Restart target',
      description: '',
      cover: { action: 'clear' },
    },
  });
  const scopeInput = {
    protocolVersion: 3 as const,
    context: intent.context,
    clientRequestId: otherId,
    commandRequestId: requestId,
    draftRevision: targetId,
    categoryId,
    expectedCategoryRevision: intent.payload.expectedCategoryRevision,
    target: null,
    declaration: {
      mime: 'image/png' as const,
      bytes: 100,
      sha256: 'a'.repeat(64),
    },
  };
  const identity = ratingCoverScopeIdentity(accountId, scopeInput);
  const prepare = {
    protocol: RATINGS_MEDIA_PROTOCOL,
    clientRequestId: otherId,
    editScopeId: identity.scopeId,
    scopeRevision: identity.scopeRevision,
    slot: 'cover' as const,
    declaration: scopeInput.declaration,
  };
  const upload = {
    version: 11,
    phase: 'upload',
    accountId,
    scopeInput,
    scope: {
      protocolVersion: 3,
      ...identity,
      targetId,
      expiresAt: timestamp,
      prepare,
    },
    status: {
      protocol: RATINGS_MEDIA_PROTOCOL,
      editScopeId: identity.scopeId,
      intentId: categoryId,
      requestId: otherId,
      requestHash: ratingCoverPrepareHash(accountId, prepare),
      serverNow: 1000,
      status: 'ready_unbound',
      assetId: targetId,
      readyRetentionUntil: 3000,
      editExpiresAt: 3000,
      bindBefore: 3000,
      mediaProof: 'current',
    },
  };
  const receipt = {
    protocolVersion: 3,
    requestId,
    operation: intent.operation,
    intentHash: ratingTargetCoverIntentHash(intent),
    outcome: 'closed',
    code: 'RATING_CREATION_CANCELLED',
  };
  try {
    const legacyIntents = [
      legacyIntent(),
      replyIntent(),
      subscriptionIntent(),
      adminIntent(),
      creationIntent(),
      ownerIntent(),
      editingIntent(),
      categoryCreationIntent(),
      scopedIntent(),
      managementIntent(),
    ];
    for (const stage of [
      'scope-unknown',
      'ready',
      'frozen',
      'commit-unknown',
      'receipt-written',
      ...legacyIntents.map((_, i) => `legacy-${i + 1}`),
      'corrupt-11',
    ]) {
      const conflict = stage.startsWith('legacy-') || stage === 'corrupt-11';
      const version = stage === 'corrupt-11' ? 11 : Number(stage.slice(7));
      const legacy = conflict
        ? {
            version,
            value:
              version === 11
                ? { corrupt: true }
                : { version, accountId, intent: legacyIntents[version - 1] },
          }
        : undefined;
      for (const mode of conflict ? ['conflict'] : ['write', 'recover']) {
        const child = fork(
          join(__dirname, 'support/native-rating-cover-process.mjs'),
          [],
          {
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          },
        );
        child.stderr?.resume();
        try {
          const result = await new Promise<{ event: string; message?: string }>(
            (resolve, reject) => {
              child.once('error', reject);
              child.once('exit', (code) => {
                if (code !== null && code !== 0)
                  reject(new Error(`Child exited ${code}`));
              });
              child.once('message', (value) =>
                resolve(value as { event: string; message?: string }),
              );
              child.send({
                mode,
                stage,
                path: join(directory, `${stage}.json`),
                credentials: wireCredentials(),
                upload,
                intent,
                receipt,
                legacy,
              });
            },
          );
          assert.equal(
            result.event,
            mode === 'write' ? 'durable' : 'recovered',
            result.message,
          );
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>((resolve) =>
              child.once('exit', () => resolve()),
            );
            child.kill('SIGKILL');
            await exited;
          }
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
