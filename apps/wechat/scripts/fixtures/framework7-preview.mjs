// Explicit fictional visual-QA state reused from the accepted presentation
// fixtures. This four-page batch never changes runtime defaults or providers.
import campusTools from './campus-tools-preview.mjs';
import discovery from './discovery-preview.mjs';
import personalSecondary from './personal-secondary-preview.mjs';

export default [
  ...campusTools.filter((fixture) => fixture.page === 'campus-tools'),
  ...discovery.filter((fixture) =>
    ['directory-hub', 'directory-list'].includes(fixture.page),
  ),
  ...personalSecondary.filter((fixture) => fixture.page === 'browsing-history'),
].map((fixture) => ({
  ...fixture,
  id: `framework7-${fixture.id}`,
  title: `Framework7 iOS · ${fixture.title}`,
}));
