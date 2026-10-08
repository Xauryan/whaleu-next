import { renderActivitiesOpenApiDocument } from './openapi-document.js';
import { renderAnnouncementsOpenApiDocument } from './openapi-document.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  renderHotOpenApiDocument,
  renderViewOpenApiDocument,
  renderDirectoryOpenApiDocument,
} from './openapi-document.js';

// This CLI runs from .openapi-build/scripts after the dedicated metadata-emitting build.
const artifact = new URL(
  '../../../../docs/openapi/view-reporting.json',
  import.meta.url,
);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: openapi.ts [--check]');
}
const rendered = await renderViewOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(artifact, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'OpenAPI artifact is missing; run npm run openapi:generate.',
      );
    }
    throw error;
  });
  if (existing !== rendered) {
    throw new Error('OpenAPI artifact is stale; run npm run openapi:generate.');
  }
  console.log('View reporting OpenAPI artifact is current.');
} else {
  await mkdir(new URL('.', artifact), { recursive: true });
  await writeFile(artifact, rendered, 'utf8');
  console.log('Generated docs/openapi/view-reporting.json.');
}

const directoryArtifact = new URL(
  '../../../../docs/openapi/organization-directory.json',
  import.meta.url,
);
const directoryRendered = await renderDirectoryOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(directoryArtifact, 'utf8').catch(
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new Error(
          'OpenAPI artifact is missing; run npm run openapi:generate.',
        );
      throw error;
    },
  );
  if (existing !== directoryRendered)
    throw new Error('OpenAPI artifact is stale; run npm run openapi:generate.');
  console.log('Organization directory OpenAPI artifact is current.');
} else {
  await writeFile(directoryArtifact, directoryRendered, 'utf8');
  console.log('Generated docs/openapi/organization-directory.json.');
}

const hotArtifact = new URL(
  '../../../../docs/openapi/community-hot.json',
  import.meta.url,
);
const hotRendered = await renderHotOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(hotArtifact, 'utf8').catch(() => {
    throw new Error(
      'Hot OpenAPI artifact is missing; run npm run openapi:generate.',
    );
  });
  if (existing !== hotRendered)
    throw new Error(
      'Hot OpenAPI artifact is stale; run npm run openapi:generate.',
    );
  console.log('Community hot OpenAPI artifact is current.');
} else {
  await writeFile(hotArtifact, hotRendered, 'utf8');
  console.log('Generated docs/openapi/community-hot.json.');
}

const announcementsArtifact = new URL(
  '../../../../docs/openapi/announcements.json',
  import.meta.url,
);
const announcementsRendered = await renderAnnouncementsOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(announcementsArtifact, 'utf8').catch(() => {
    throw new Error(
      'Announcements OpenAPI artifact is missing; run npm run openapi:generate.',
    );
  });
  if (existing !== announcementsRendered)
    throw new Error(
      'Announcements OpenAPI artifact is stale; run npm run openapi:generate.',
    );
  console.log('Announcements OpenAPI artifact is current.');
} else {
  await writeFile(announcementsArtifact, announcementsRendered, 'utf8');
  console.log('Generated docs/openapi/announcements.json.');
}

const { renderSearchOpenApiDocument } = await import('./openapi-document.js');
const searchArtifact = new URL(
  '../../../../docs/openapi/community-search.json',
  import.meta.url,
);
const searchRendered = await renderSearchOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(searchArtifact, 'utf8').catch(() => {
    throw new Error(
      'Search OpenAPI artifact is missing; run npm run openapi:generate.',
    );
  });
  if (existing !== searchRendered)
    throw new Error(
      'Search OpenAPI artifact is stale; run npm run openapi:generate.',
    );
  console.log('Community search OpenAPI artifact is current.');
} else {
  await writeFile(searchArtifact, searchRendered, 'utf8');
  console.log('Generated docs/openapi/community-search.json.');
}

const activitiesArtifact = new URL(
  '../../../../docs/openapi/activities.json',
  import.meta.url,
);
const activitiesRendered = await renderActivitiesOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(activitiesArtifact, 'utf8').catch(() => {
    throw new Error(
      'Activities OpenAPI artifact missing; run npm run openapi:generate.',
    );
  });
  if (existing !== activitiesRendered)
    throw new Error(
      'Activities OpenAPI artifact is stale; run npm run openapi:generate.',
    );
  console.log('Activities OpenAPI artifact is current.');
} else {
  await writeFile(activitiesArtifact, activitiesRendered, 'utf8');
  console.log('Generated docs/openapi/activities.json.');
}
