import type { PublishPost } from './contracts.js';
/** Keep C1 property order and absent-component hashes unchanged, including explicit none. */
export function postIntent(body: PublishPost) {
  return {
    spaceId: body.spaceId,
    category: body.category,
    text: body.text,
    imageAssetIds: body.imageAssetIds,
    authorMode: body.authorMode,
    commentsPolicy: body.commentsPolicy,
    ...(body.component?.kind === 'poll' ? { component: body.component } : {}),
  };
}
