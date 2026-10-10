/** A shipped route declaration is not evidence that production sources or authority are available. */
export const ratingCategoryScopedNativeRoutes = Object.freeze(
  [
    ['Context', 'POST', '/v2/ratings/category-management/contexts'],
    ['List', 'GET', '/v2/ratings/category-management/categories'],
    ['Detail', 'GET', '/v2/ratings/category-management/categories/:categoryId'],
    [
      'History',
      'GET',
      '/v2/ratings/category-management/categories/:categoryId/history',
    ],
    ['SystemOptions', 'GET', '/v2/ratings/category-management/system-options'],
    ['Prepare', 'POST', '/v2/ratings/category-management/prepare'],
    ['Commit', 'POST', '/v2/ratings/category-management/commit'],
    ['Cancel', 'POST', '/v2/ratings/category-management/cancel'],
  ].map(([name, method, path]) =>
    Object.freeze({
      operationId: `ratingScopedCategoryManagement${name}`,
      method: method!,
      path: path!,
    }),
  ),
);
