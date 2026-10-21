import type { SessionStore } from '../auth/session';
import { clientConfiguration } from '../config';
import { WechatStorage } from '../platform/wechat';
import { BrowsingHistoryStore } from './store';
const stores = new WeakMap<SessionStore, BrowsingHistoryStore>();
export function nativeBrowsingHistory(
  sessions: SessionStore,
): BrowsingHistoryStore {
  let store = stores.get(sessions);
  if (!store) {
    store = new BrowsingHistoryStore(
      sessions,
      new WechatStorage(wx),
      clientConfiguration.apiOrigin,
    );
    stores.set(sessions, store);
  }
  return store;
}
