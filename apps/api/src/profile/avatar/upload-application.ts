import { lockSafetyPolicy } from '../../safety/locks.js';
import type { MediaIngressClaim } from '../../media/application-v2.js';
import type { StoredObjectMeasurement } from '../../media/storage-port.js';
import type { MediaUploadObserved } from '../../media/contracts-v2.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  profileMediaRequestHash,
  prepareProfileMediaSchema,
  profileMediaGrantSchema,
  profileMediaUploadObservedSchema,
} from '../../media/contracts-profile.js';
import { PROFILE_MEDIA_PROTOCOL } from './contracts.js';
import type { ProfileAvatarService } from './service.js';

export class ProfileAvatarUploadApplication {
  constructor(readonly owner: ProfileAvatarService) {}
  prepare(token: string, raw: unknown) {
    return this.owner.authorized(token, async (session, tx) => {
      const input = prepareProfileMediaSchema.parse(raw),
        hash = profileMediaRequestHash(session.accountId, input);
      const previous = await this.owner.recovery.recover(
        session.accountId,
        input.clientRequestId,
        tx,
      );
      if (previous.state !== 'not_recorded') {
        if (previous.requestHash !== hash)
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        if (previous.state !== 'recorded')
          throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
        return previous.status;
      }
      if (!this.owner.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
      const scope = await this.owner.scopes.authorizeProfile(
        session.accountId,
        input,
        tx,
      );
      const receipt = await this.owner.intents.prepare(scope, tx);
      return this.owner.recovery.status(
        session.accountId,
        receipt.intentId,
        tx,
      );
    });
  }
  recover(token: string, requestId: string) {
    return this.owner.authorized(
      token,
      (session, tx) =>
        this.owner.recovery.recover(session.accountId, requestId, tx),
      false,
    );
  }
  cancelRequest(token: string, requestId: string, raw: unknown) {
    return this.owner.authorized(token, (session, tx) =>
      this.owner.recovery.cancelRequest(session.accountId, requestId, raw, tx),
    );
  }
  status(token: string, editId: string) {
    return this.owner.authorized(
      token,
      async (session, tx) =>
        this.owner.recovery.status(
          session.accountId,
          await this.owner.recovery.resolveProfileIntent(
            session.accountId,
            editId,
            tx,
          ),
          tx,
        ),
      false,
    );
  }
  async finalize(token: string, editId: string) {
    const status = await this.status(token, editId);
    if (
      ['bound_history', 'terminal', 'ready_unbound', 'unavailable'].includes(
        status.status,
      )
    )
      return status;
    return this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress();
      const id = await this.owner.recovery.resolveProfileIntent(
        session.accountId,
        editId,
        tx,
      );
      await this.owner.scopes.authorizeProfile(
        session.accountId,
        await ingress.originalProfileInput(session.accountId, id, tx),
        tx,
      );
      await this.owner.lifecycle.finalize(session.accountId, id, tx);
      return this.owner.recovery.status(session.accountId, id, tx);
    });
  }
  async grant(token: string, editId: string) {
    const result = await this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress(),
        id = await this.owner.recovery.resolveProfileIntent(
          session.accountId,
          editId,
          tx,
        );
      return ingress.grant(
        session,
        id,
        await this.owner.scopes.authorizeProfile(
          session.accountId,
          await ingress.originalProfileInput(session.accountId, id, tx),
          tx,
        ),
        this.owner.scopes,
        tx,
      );
    });
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    const { version: _version, ...grant } = result;
    void _version;
    return profileMediaGrantSchema.parse({
      ...grant,
      protocol: PROFILE_MEDIA_PROTOCOL,
      editId,
    });
  }
  admit(
    token: string,
    editId: string,
    grantId: string,
  ): Promise<MediaIngressClaim> {
    return this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress(),
        id = await this.owner.recovery.resolveProfileIntent(
          session.accountId,
          editId,
          tx,
        );
      return ingress.admit(
        session,
        id,
        grantId,
        await this.owner.scopes.authorizeProfile(
          session.accountId,
          await ingress.originalProfileInput(session.accountId, id, tx),
          tx,
        ),
        this.owner.scopes,
        tx,
      );
    });
  }
  observe(
    token: string,
    claim: MediaIngressClaim,
    measurement: StoredObjectMeasurement,
  ): Promise<MediaUploadObserved> {
    return this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress();
      return ingress.observe(
        session,
        claim,
        measurement,
        await this.owner.scopes.authorizeProfile(
          session.accountId,
          await ingress.originalProfileInput(
            session.accountId,
            claim.intentId,
            tx,
          ),
          tx,
        ),
        this.owner.scopes,
        tx,
      );
    });
  }
  observed(editId: string, result: MediaUploadObserved) {
    const { version: _version, ...observation } = result;
    void _version;
    return profileMediaUploadObservedSchema.parse({
      ...observation,
      protocol: PROFILE_MEDIA_PROTOCOL,
      editId,
    });
  }
  retire(
    claim: MediaIngressClaim,
    proof?: unknown,
    transferredBytes = 0,
  ): Promise<void> {
    return this.owner.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        if (
          await this.requireIngress().retire(claim, proof, transferredBytes, tx)
        )
          await this.owner.recovery.cancel(
            claim.actorAccountId,
            claim.intentId,
            tx,
          );
      },
      { isolationLevel: 'read committed' },
    );
  }
  private requireIngress() {
    if (!this.owner.ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.owner.ingress;
  }
}
