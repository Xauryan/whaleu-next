// Fictional local-only states. Reuse the existing content-first notification
// fixtures; no inbox sender rows, follow/activity provider or unread count is
// invented. The source renderer expands the real native component WXML/slots.
import notifications from './notification-details-preview.mjs';
export default notifications.map((fixture) => ({
  ...structuredClone(fixture),
  id: `framework7-notifications-${fixture.id}`,
  title: `Framework7 iOS 原生通知 · ${fixture.title}`,
}));
