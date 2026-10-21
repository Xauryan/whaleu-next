/** Read-only CDP observations. Never emit URLs, text, exception details or
 * arbitrary evaluation values. Diagnostic failures never replace test failures. */
import { performance } from 'node:perf_hooks';
type Command = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  session?: string,
) => Promise<T>;
type Packet = { method?: string; params?: Record<string, unknown> };
const observation =
  '({hidden:document.hidden,visibilityState:document.visibilityState,hasFocus:document.hasFocus(),readyState:document.readyState})';
const safeId = (value: unknown) =>
  typeof value === 'string' && /^[a-fA-F0-9]{1,64}$/.test(value)
    ? value
    : 'unavailable';
export function browserVisibilityDiagnostics(
  command: Command,
  write = (line: string) => console.log(line),
  now = () => performance.now(),
  budgetMs = 250,
) {
  const start = now();
  const events: Record<string, unknown>[] = [];
  const record = (packet: Packet) => {
    if (
      ![
        'Target.targetCreated',
        'Target.targetInfoChanged',
        'Target.targetDestroyed',
        'Target.targetCrashed',
      ].includes(packet.method ?? '')
    )
      return;
    const info = packet.params?.['targetInfo'] as
      Record<string, unknown> | undefined;
    events.push({
      ms: Math.max(0, Math.round(now() - start)),
      event: packet.method,
      targetId: safeId(info?.['targetId'] ?? packet.params?.['targetId']),
    });
    if (events.length > 16) events.shift();
  };
  const emit = (data: object) => {
    try {
      write(`[browser-visibility] ${JSON.stringify(data)}`);
    } catch {
      /* Diagnostics must not mask the test. */
    }
  };
  const mark = (
    phase:
      | 'background-activate-start'
      | 'background-activate-complete'
      | 'foreground-activate-start'
      | 'foreground-activate-complete',
  ) => {
    emit({ phase, ms: Math.max(0, Math.round(now() - start)) });
  };
  // Each capture has ONE wall-clock budget, not one deadline per command.
  // Late replies are observed; only a late attachment may issue its cleanup.
  const budget = () => {
    const deadline = performance.now() + Math.max(1, Math.min(250, budgetMs));
    let exhausted = false;
    const run = <T>(
      operation: () => Promise<T>,
      late?: (value: T) => void,
    ): Promise<T> => {
      const remaining = deadline - performance.now();
      if (exhausted || remaining <= 0) {
        exhausted = true;
        return Promise.reject(new Error('Diagnostic budget exhausted'));
      }
      return new Promise<T>((resolve, reject) => {
        let expired = false;
        const timer = setTimeout(() => {
          expired = true;
          exhausted = true;
          reject(new Error('Diagnostic budget exhausted'));
        }, remaining);
        Promise.resolve()
          .then(operation)
          .then(
            (value) => {
              clearTimeout(timer);
              if (expired) {
                try {
                  late?.(value);
                } catch {
                  /* Best effort cleanup only. */
                }
              } else resolve(value);
            },
            (error) => {
              clearTimeout(timer);
              if (!expired) reject(error);
              // A rejection after timeout is deliberately observed here.
            },
          );
      });
    };
    return { run, exhausted: () => exhausted };
  };
  const detach = (sessionId: string) => {
    // This is the sole operation allowed after an expired capture. It cannot
    // mutate global session selection, trigger an action or mask its result.
    void Promise.resolve()
      .then(() => command('Target.detachFromTarget', { sessionId }, ''))
      .catch(() => {
        emit({ phase: 'diagnostic-detach', supported: false });
      });
  };
  const enable = async () => {
    try {
      await budget().run(() =>
        command('Target.setDiscoverTargets', { discover: true }, ''),
      );
    } catch {
      emit({ phase: 'discovery', supported: false });
    }
  };
  const capture = async (
    phase:
      | 'before-background'
      | 'after-background'
      | 'background-failed'
      | 'before-foreground'
      | 'after-foreground'
      | 'foreground-failed',
    targets: readonly {
      role: 'primary' | 'other';
      targetId: string;
      sessionId?: string;
    }[],
  ) => {
    const bounded = budget();
    const inspect: Command = (method, params, session) =>
      bounded.run(() => command(method, params, session));
    const result: object[] = [];
    for (const target of targets.slice(0, 2)) {
      const item: Record<string, unknown> = {
        role: target.role,
        targetId: safeId(target.targetId),
      };
      let attached: string | undefined;
      try {
        const answer = await inspect<{
          targetInfo?: { targetId?: unknown; browserContextId?: unknown };
        }>('Target.getTargetInfo', { targetId: target.targetId }, '');
        const info = answer.targetInfo;
        item['targetVerified'] = info?.targetId === target.targetId;
        if (item['targetVerified'])
          item['browserContextId'] =
            info?.browserContextId === undefined
              ? 'default'
              : safeId(info.browserContextId);
      } catch {
        item['targetInfoSupported'] = false;
      }
      try {
        const window = await inspect<{ windowId?: unknown }>(
          'Browser.getWindowForTarget',
          { targetId: target.targetId },
          '',
        );
        item['windowId'] =
          Number.isSafeInteger(window.windowId) && Number(window.windowId) >= 0
            ? window.windowId
            : 'unavailable';
      } catch {
        item['windowSupported'] = false;
      }
      try {
        let session = target.sessionId;
        if (!session) {
          attached = (
            await bounded.run(
              () =>
                command<{ sessionId: string }>(
                  'Target.attachToTarget',
                  { targetId: target.targetId, flatten: true },
                  '',
                ),
              (late) => detach(late.sessionId),
            )
          ).sessionId;
          session = attached;
        }
        const answer = await inspect<{
          result?: { value?: Record<string, unknown> };
          exceptionDetails?: unknown;
        }>(
          'Runtime.evaluate',
          { expression: observation, returnByValue: true },
          session,
        );
        const value = answer.exceptionDetails
          ? undefined
          : answer.result?.value;
        item['observationSupported'] = !!value;
        if (typeof value?.['hidden'] === 'boolean')
          item['hidden'] = value['hidden'];
        if (typeof value?.['hasFocus'] === 'boolean')
          item['hasFocus'] = value['hasFocus'];
        if (['hidden', 'visible'].includes(String(value?.['visibilityState'])))
          item['visibilityState'] = value!['visibilityState'];
        if (
          ['loading', 'interactive', 'complete'].includes(
            String(value?.['readyState']),
          )
        )
          item['readyState'] = value!['readyState'];
      } catch {
        item['observationSupported'] = false;
      } finally {
        if (attached) detach(attached);
      }
      result.push(item);
    }
    emit({
      phase,
      ms: Math.max(0, Math.round(now() - start)),
      budgetExhausted: bounded.exhausted(),
      targets: result,
      events: [...events],
    });
  };
  // Observations wrap the unchanged action and assertion; preserve the exact
  // thrown object even if metadata collection itself is unavailable.
  const around = async (
    direction: 'background' | 'foreground',
    targets: Parameters<typeof capture>[1],
    action: () => Promise<void>,
  ) => {
    try {
      await capture(`before-${direction}`, targets);
    } catch {
      /* Best effort only. */
    }
    try {
      await action();
    } catch (error) {
      try {
        await capture(`${direction}-failed`, targets);
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    }
    try {
      await capture(`after-${direction}`, targets);
    } catch {
      /* Best effort only. */
    }
  };
  return { record, enable, capture, around, mark };
}
