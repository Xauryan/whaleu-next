/** Purpose-specific native consumer inventory. No real provider is activated here. */
export const ratingAssistanceNativeRoutes = Object.freeze(
  [
    {
      operationId: 'ratingAssistanceCreate',
      method: 'POST',
      path: '/v2/ratings/assistance/requests',
    },
    {
      operationId: 'ratingAssistanceStatus',
      method: 'GET',
      path: '/v2/ratings/assistance/requests/:requestId',
    },
    {
      operationId: 'ratingAssistanceResult',
      method: 'GET',
      path: '/v2/ratings/assistance/requests/:requestId/result',
    },
    {
      operationId: 'ratingAssistanceCancel',
      method: 'POST',
      path: '/v2/ratings/assistance/requests/:requestId/cancel',
    },
  ].map(Object.freeze),
);
