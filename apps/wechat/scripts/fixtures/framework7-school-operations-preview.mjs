// Fictional source-only cases. No real management, accounts, media or providers.
// Native components/slots are rendered by the existing preview renderer.
import operations from './school-operations-preview.mjs';
export default operations.map((fixture) => ({
  ...fixture,
  id: `framework7-${fixture.id}`,
  title: `Framework7 iOS 原生学校管理 · ${fixture.title}`,
  patch: structuredClone(fixture.patch),
}));
