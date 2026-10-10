import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { CurrentMediaSession } from '../src/identity/current-media-session.js';
import { RatingsTargetUploadApplication } from '../src/media/application-ratings.js';
import type { RatingsTargetMediaOwner } from '../src/media/application-ratings.js';
import { ratingsMediaRequestHash } from '../src/media/contracts-ratings.js';
import { ApplicationError } from '../src/http/application-error.js';

function fixture() {
  const actor = randomUUID(),
    requestId = randomUUID(),
    editScopeId = randomUUID();
  const input = {
    protocol: 'ratings-target-media-v1',
    clientRequestId: requestId,
    editScopeId,
    scopeRevision: 'a'.repeat(64),
    slot: 'cover',
    declaration: { mime: 'image/png', bytes: 12, sha256: 'b'.repeat(64) },
  };
  const status = {
    protocol: 'ratings-target-media-v1',
    editScopeId,
    intentId: randomUUID(),
    requestId,
    requestHash: ratingsMediaRequestHash(actor, input),
    serverNow: 1,
    status: 'terminal',
    reason: 'cancelled',
    cleanup: 'pending',
  };
  let previous: unknown = {
    protocol: 'ratings-target-media-v1',
    requestId,
    requestHash: null,
    serverNow: 1,
    state: 'not_recorded',
  };
  let authenticated = 0;
  const owner = {
    runtime: null,
    async authorized<T>(
      token: string,
      run: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    ) {
      authenticated++;
      if (token !== 'original-token')
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      return run({ accountId: actor } as CurrentMediaSession, {} as PoolClient);
    },
    recovery: {
      async recover(account: string, key: string) {
        assert.equal(account, actor);
        assert.equal(key, requestId);
        return previous;
      },
    },
    scopes: {
      async authorizeRatings() {
        throw new Error('Disabled runtime must not prepare');
      },
    },
  } as unknown as RatingsTargetMediaOwner;
  return {
    input,
    status,
    app: new RatingsTargetUploadApplication(owner),
    authenticated: () => authenticated,
    recorded() {
      previous = {
        protocol: 'ratings-target-media-v1',
        requestId,
        requestHash: status.requestHash,
        serverNow: 1,
        state: 'recorded',
        status,
      };
    },
  };
}
test('Ratings default runtime authenticates and fails closed before preparing/uploading', async () => {
  const f = fixture();
  await assert.rejects(
    f.app.prepare('original-token', f.input),
    (error) =>
      error instanceof ApplicationError && error.code === 'MEDIA_UNAVAILABLE',
  );
  assert.equal(f.authenticated(), 1);
});
test('Ratings original historical request wins before runtime activation or fresh scope issuance', async () => {
  const f = fixture();
  f.recorded();
  assert.deepEqual(await f.app.prepare('original-token', f.input), f.status);
  await assert.rejects(
    f.app.prepare('original-token', {
      ...f.input,
      declaration: { ...f.input.declaration, bytes: 13 },
    }),
    (error) =>
      error instanceof ApplicationError &&
      error.code === 'MEDIA_REQUEST_CONFLICT',
  );
  await assert.rejects(f.app.prepare('other-token', f.input));
});
