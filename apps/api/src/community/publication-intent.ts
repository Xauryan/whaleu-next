import { textSourceDescriptorSchema } from './text-source/protocol.js';
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
    ...(body.trading ? { trading: body.trading } : {}),
    ...(body.feedback ? { feedback: body.feedback } : {}),
    ...(body.component?.kind === 'poll' ||
    body.component?.kind === 'formation' ||
    body.component?.kind === 'rating_target_link'
      ? {
          component:
            body.component.kind === 'rating_target_link'
              ? {
                  kind: body.component.kind,
                  targetId: body.component.targetId,
                  label: body.component.label,
                  selector: body.component.selector,
                  expectedTargetRevision: body.component.expectedTargetRevision,
                  expectedCategoryRevision:
                    body.component.expectedCategoryRevision,
                  expectedSourceRevision: body.component.expectedSourceRevision,
                }
              : body.component,
        }
      : {}),
    ...(body.allowAnonymousDm === undefined
      ? {}
      : { allowAnonymousDm: body.allowAnonymousDm }),
    ...(body.syncToRelatedCampuses === true
      ? { syncToRelatedCampuses: true as const }
      : {}),
    ...(body.textSource === undefined
      ? {}
      : { textSource: textSourceDescriptorSchema.parse(body.textSource) }),
  };
}
