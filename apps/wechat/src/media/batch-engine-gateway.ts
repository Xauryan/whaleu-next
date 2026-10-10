import type { BatchGateway } from './batch-engine-contracts';
import type { BatchRuntimeOptions } from './batch-runtime';
import type { MediaSession } from './contracts';
import { unavailableBatchGateway } from './batch-gateway';
import { unavailableDiscussionBatchGateway } from './discussion-batch-gateway';
/** Each request is routed from the durable original identity, never the page URL. */
export function batchEngineGateway(options: BatchRuntimeOptions): BatchGateway {
  const byVersion = (version: number): BatchGateway =>
    version === 4
      ? (options.discussionGateway ?? unavailableDiscussionBatchGateway)
      : (options.gateway ?? unavailableBatchGateway);
  const forSession = (session: MediaSession): BatchGateway => {
    const actor = session.current().credentials?.accountId;
    return byVersion(actor ? (options.pending.load(actor)?.version ?? 3) : 3);
  };
  return {
    prepare: (identity, session, cancel) =>
      byVersion(identity.version === 2 ? 4 : 3).prepare(
        identity,
        session,
        cancel,
      ),
    recover: (id, session, cancel) =>
      forSession(session).recover(id, session, cancel),
    cancel: (id, hash, session, cancel) =>
      forSession(session).cancel(id, hash, session, cancel),
    command: (id, command, session, cancel) =>
      forSession(session).command(id, command, session, cancel),
    recoverPublication: (reference, assets, session, cancel, target) =>
      byVersion(
        reference.operation === 'publish_post' ? 3 : 4,
      ).recoverPublication(reference, assets, session, cancel, target),
    fencePublication: (id, reference, assets, session, cancel, target) =>
      byVersion(
        reference.operation === 'publish_post' ? 3 : 4,
      ).fencePublication(id, reference, assets, session, cancel, target),
    prepareMember: (id, input, session, cancel) =>
      forSession(session).prepareMember(id, input, session, cancel),
    memberStatus: (id, session, cancel) =>
      forSession(session).memberStatus(id, session, cancel),
    grant: (id, session, cancel) =>
      forSession(session).grant(id, session, cancel),
    finalize: (id, session, cancel) =>
      forSession(session).finalize(id, session, cancel),
  };
}
