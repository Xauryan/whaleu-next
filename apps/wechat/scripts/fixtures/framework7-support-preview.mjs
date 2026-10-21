// Fictional source-only support cases, never real contacts, accounts or providers.
// Native component templates/slots are expanded; device acceptance remains open.
import support from './support-preview.mjs';
export default support.map((fixture) => ({
  ...fixture,
  id: fixture.id.replace(/^support-/, 'framework7-support-'),
  title: `Framework7 iOS 原生支持与安全 · ${fixture.title}`,
  patch: structuredClone(fixture.patch),
}));
