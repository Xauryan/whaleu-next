import { z } from 'zod';
import { ratingCategorySchema } from '../contracts.js';
import {
  ratingScopedContextSchema,
  scopedDigest,
} from '../scoped/contracts.js';
import { ratingScopedCategoryPageSchema } from '../scoped/read.service.js';
import { categoryIconMediaDescriptorSchema } from '../../media/contracts-category-icon.js';
/** Category icon reads are explicit; an old complete Category DTO never silently
 * drops the image portion of a definition. Other owner capabilities stay distinct. */
export const ratingCategoryIconPublicContextSchema = z
  .strictObject({
    ...ratingScopedContextSchema.shape,
    protocolVersion: z.literal(5),
    mediaSnapshot: scopedDigest,
  })
  .superRefine((context, ctx) => {
    const { mediaSnapshot: _snapshot, ...original } = context;
    void _snapshot;
    if (
      !context.capabilities.includes('category_icon') ||
      !ratingScopedContextSchema.safeParse({ ...original, protocolVersion: 2 })
        .success
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Exact Category icon public context required',
      });
  });
export const ratingCategoryWithIconSchema = ratingCategorySchema.safeExtend({
  icon: categoryIconMediaDescriptorSchema.nullable(),
});
export const ratingCategoryIconPageSchema =
  ratingScopedCategoryPageSchema.safeExtend({
    items: z.array(ratingCategoryWithIconSchema).max(50),
  });
