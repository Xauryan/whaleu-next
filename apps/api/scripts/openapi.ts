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

const { renderErrandsOpenApiDocument } = await import('./openapi-document.js');
const errandsArtifact = new URL(
  '../../../../docs/openapi/errands.json',
  import.meta.url,
);
const errandsRendered = await renderErrandsOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(errandsArtifact, 'utf8').catch(() => {
    throw new Error(
      'Errands OpenAPI artifact missing; run npm run openapi:generate.',
    );
  });
  if (existing !== errandsRendered)
    throw new Error(
      'Errands OpenAPI artifact stale; run npm run openapi:generate.',
    );
  console.log('Errands OpenAPI artifact is current.');
} else {
  await writeFile(errandsArtifact, errandsRendered, 'utf8');
  console.log('Generated docs/openapi/errands.json.');
}

const { renderRatingsOpenApiDocument } = await import('./openapi-document.js');
const ratingsArtifact = new URL(
  '../../../../docs/openapi/ratings.json',
  import.meta.url,
);
const ratingsRendered = await renderRatingsOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(ratingsArtifact, 'utf8').catch(() => {
    throw new Error(
      'Ratings OpenAPI artifact missing; run npm run openapi:generate.',
    );
  });
  if (existing !== ratingsRendered)
    throw new Error(
      'Ratings OpenAPI artifact stale; run npm run openapi:generate.',
    );
  console.log('Ratings OpenAPI artifact is current.');
} else {
  await writeFile(ratingsArtifact, ratingsRendered, 'utf8');
  console.log('Generated docs/openapi/ratings.json.');
}

const { renderMessagingOpenApiDocument } =
  await import('./openapi-document.js');
const messagingArtifact = new URL(
  '../../../../docs/openapi/private-messages.json',
  import.meta.url,
);
const messagingRendered = await renderMessagingOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(messagingArtifact, 'utf8');
  if (existing !== messagingRendered)
    throw new Error(
      'Private messages OpenAPI artifact stale; run npm run openapi:generate.',
    );
  console.log('Private messages OpenAPI artifact is current.');
} else {
  await writeFile(messagingArtifact, messagingRendered, 'utf8');
  console.log('Generated docs/openapi/private-messages.json.');
}

const { renderMediaOpenApiDocument } = await import('./openapi-document.js');
const mediaArtifact = new URL(
  '../../../../docs/openapi/media.json',
  import.meta.url,
);
const mediaRendered = await renderMediaOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(mediaArtifact, 'utf8').catch(() => {
    throw new Error(
      'Media OpenAPI artifact missing; run npm run openapi:generate.',
    );
  });
  if (existing !== mediaRendered)
    throw new Error(
      'Media OpenAPI artifact stale; run npm run openapi:generate.',
    );
  console.log('Media OpenAPI artifact is current.');
} else {
  await writeFile(mediaArtifact, mediaRendered, 'utf8');
  console.log('Generated docs/openapi/media.json.');
}

const { renderProfileAvatarOpenApiDocument } =
  await import('./openapi-document.js');
const profileAvatarArtifact = new URL(
  '../../../../docs/openapi/profile-avatars.json',
  import.meta.url,
);
const profileAvatarRendered = await renderProfileAvatarOpenApiDocument();
if (args[0] === '--check') {
  const existing = await readFile(profileAvatarArtifact, 'utf8');
  if (existing !== profileAvatarRendered)
    throw new Error(
      'Profile avatar OpenAPI artifact stale; run npm run openapi:generate.',
    );
  console.log('Profile avatar OpenAPI artifact is current.');
} else {
  await writeFile(profileAvatarArtifact, profileAvatarRendered, 'utf8');
  console.log('Generated docs/openapi/profile-avatars.json.');
}
