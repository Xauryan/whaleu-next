// Fictional source-only inputs inherited from the contract-checked personal set.
// No real account, payment, provider, or business action is exercised here.
import personal from './personal-secondary-preview.mjs';
const pages = new Set([
  'public-profile',
  'community-blocks',
  'experience',
  'experience-ranking',
  'wallet',
]);
export default personal
  .filter((fixture) => pages.has(fixture.page))
  .map((fixture) => ({
    ...fixture,
    id: fixture.id.replace(/^personal-/, 'framework7-personal-'),
    title: `Framework7 iOS 原生个人页面 · ${fixture.title}`,
  }));
