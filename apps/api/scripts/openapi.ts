import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renderViewOpenApiDocument } from './openapi-document.js';

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
