/** Diagnostics deliberately exclude URLs, headers, bodies, console arguments,
 * exception text and CDP command parameters: these can contain fixture tokens. */
export function browserDiagnostics(
  write = (line: string) => console.log(line),
) {
  const events: Record<string, string | number | boolean>[] = [];
  const record = (packet: {
    method?: string;
    params?: Record<string, unknown>;
  }) => {
    const params = packet.params ?? {};
    let event: Record<string, string | number | boolean> | undefined;
    if (packet.method === 'Network.loadingFailed') {
      event = { kind: 'network-failed', canceled: params['canceled'] === true };
      const code = params['errorText'];
      if (
        typeof code === 'string' &&
        code.length <= 80 &&
        /^net::ERR_[A-Z_]+$/.test(code)
      )
        event['code'] = code;
    } else if (packet.method === 'Network.responseReceived') {
      const status = (params['response'] as { status?: unknown } | undefined)
        ?.status;
      if (
        typeof status === 'number' &&
        Number.isInteger(status) &&
        status >= 400 &&
        status <= 599
      )
        event = { kind: 'http-error', status };
    } else if (packet.method === 'Runtime.consoleAPICalled') {
      const type = params['type'];
      if (type === 'error' || type === 'warning')
        event = { kind: 'console', type };
    } else if (packet.method === 'Runtime.exceptionThrown')
      event = { kind: 'runtime-exception' };
    if (event) {
      events.push(event);
      if (events.length > 32) events.shift();
    }
  };
  return {
    record,
    flush(phase: 'command-timeout' | 'condition-timeout' | 'cleanup') {
      write(`[browser-diagnostic] ${JSON.stringify({ phase, events })}`);
    },
  };
}

/** One hook owns all acquired resources. A failed earlier close must not skip
 * the remaining fixture cleanup. Timeouts FAIL; the process guard is the last
 * boundary for an underlying close that cannot be cancelled. */
export async function closeBrowserResources(
  resources: readonly (readonly [string, () => Promise<unknown>])[],
  { timeoutMs = 15000, write = (line: string) => console.log(line) } = {},
) {
  const errors: unknown[] = [];
  const failed: string[] = [];
  for (const [label, close] of resources) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    write(`[browser-cleanup] ${label}: begin`);
    try {
      await Promise.race([
        Promise.resolve().then(close),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Browser cleanup timeout: ${label}`)),
            timeoutMs,
          );
        }),
      ]);
      write(`[browser-cleanup] ${label}: done`);
    } catch (error) {
      errors.push(error);
      failed.push(label);
      write(`[browser-cleanup] ${label}: failed`);
    } finally {
      clearTimeout(timer);
      const active: Record<string, number> = {};
      for (const type of process.getActiveResourcesInfo())
        active[type] = (active[type] ?? 0) + 1;
      write(
        `[browser-cleanup] active-resource-types: ${JSON.stringify(active)}`,
      );
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `Browser cleanup failed: ${failed.join(', ')}`,
      { cause: errors[0] },
    );
}
