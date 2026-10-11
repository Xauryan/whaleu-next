/** Internal service aliases never enter the original v2 codec or request owner. */
export {
  RATING_CATEGORY_MANAGEMENT_POLICY,
  RATING_CATEGORY_SYSTEM_REGISTRY,
  ratingCategoryScopedOperations,
  ratingCategorySystemOptionsSchema,
  ratingCategoryManagementHistorySchema,
} from './scoped-contracts.js';
export {
  ratingCategoryIconIntentSchema as ratingCategoryScopedIntentSchema,
  ratingCategoryIconIntentHash as ratingCategoryScopedIntentHash,
  ratingCategoryIconReceiptSchema as ratingCategoryScopedReceiptSchema,
  ratingCategoryIconPreparationSchema as ratingCategoryScopedPreparationSchema,
  ratingCategoryIconCommitSchema as ratingCategoryScopedCommitSchema,
  ratingCategoryIconContextSchema as ratingCategoryManagementContextSchema,
  ratingManagedCategoryIconsSchema as ratingManagedCategoriesSchema,
  type RatingCategoryIconIntent as RatingCategoryScopedIntent,
  type RatingCategoryIconReceipt as RatingCategoryScopedReceipt,
} from './icon-contracts.js';
