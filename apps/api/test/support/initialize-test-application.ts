/** Test-only lifecycle ownership. A successful app is handed back to its caller;
 * failures close this exact created app (or the module if creation itself failed)
 * and preserve both the original error and any cleanup error. */
export async function initializeTestApplication<
  T extends { close(): Promise<void> },
>(
  module: { createNestApplication(): T; close(): Promise<void> },
  initialize: (app: T) => Promise<void>,
): Promise<T> {
  let app: T | undefined;
  try {
    app = module.createNestApplication();
    await initialize(app);
    return app;
  } catch (error) {
    let cleanupFailure: { error: unknown } | undefined;
    try {
      if (app) await app.close();
      else await module.close();
    } catch (cleanupError) {
      cleanupFailure = { error: cleanupError };
    }
    if (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure.error],
        'Test application initialization and cleanup both failed',
        { cause: error },
      );
    }
    throw error;
  }
}
