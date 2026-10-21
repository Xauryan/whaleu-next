// Fictional static states only. No real accounts, private evidence or operations.
import moderation from './moderation-preview.mjs';
export default moderation.map((fixture) => ({
  ...fixture,
  id: `framework7-${fixture.id}`,
  title: `Framework7 iOS 原生审核与管理 · ${fixture.title}`,
  patch: structuredClone(fixture.patch),
}));
