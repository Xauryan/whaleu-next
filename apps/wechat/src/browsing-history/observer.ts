import type { SessionStore, SessionTicket } from '../auth/session';
import type { ViewObservationSink } from '../community/view-observer';
import type { BrowsingHistoryStore } from './store';
/** Reuses viewport evidence, but local history does not depend on analytics transport. */
export function historyObservationSink(
  sessions: SessionStore,
  history: BrowsingHistoryStore,
): ViewObservationSink {
  const current = (owner: SessionTicket) => {
    try {
      sessions.assertCurrent(owner);
      return !!owner.credentials;
    } catch {
      return false;
    }
  };
  return {
    captureOwner: () => sessions.snapshot(),
    canPresent: current,
    canObserve: current,
    subscribeInvalidation: (listener) => sessions.subscribe(listener),
    observe: (kind, postId, owner) => {
      if (!current(owner)) return;
      if (kind === 'detail_visit') history.record(postId, owner);
    },
  };
}
