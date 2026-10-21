/**
 * Source-only execution of trusted repository presentation components.
 * This is a bounded synchronous preview harness, not a sandbox or a native
 * renderer. It runs attached, render acknowledgements and synthetic timers,
 * captures actual projected data, then detaches. It never invokes UI handlers.
 */
const maxCallbacks = 256;
const maxElapsedMs = 10_000;

function synchronous(callback, receiver, args = []) {
  if (typeof callback !== 'function')
    throw new Error('Preview lifecycle callback must be a function');
  if (callback.constructor?.name === 'AsyncFunction')
    throw new Error('Preview lifecycle must not start asynchronous work');
  const result = callback.apply(receiver, args);
  if (result && typeof result.then === 'function')
    throw new Error('Preview lifecycle must not return asynchronous work');
}

function previewScheduler() {
  let nextId = 1;
  let now = 0;
  let scheduled = 0;
  let executed = 0;
  const pending = new Map();
  const schedule = (kind, callback, delay, receiver, args) => {
    if (typeof callback !== 'function')
      throw new Error('Preview lifecycle callback must be a function');
    const duration = Number(delay ?? 0);
    if (
      !Number.isFinite(duration) ||
      duration < 0 ||
      now + duration > maxElapsedMs
    )
      throw new Error('Preview lifecycle exceeds synthetic time limit');
    if (++scheduled > maxCallbacks)
      throw new Error('Preview lifecycle exceeds synthetic callback limit');
    const id = nextId++;
    pending.set(id, {
      kind,
      callback,
      due: now + duration,
      receiver,
      args,
    });
    return id;
  };
  const unsupported = () => {
    throw new Error(
      'Preview lifecycle cannot start recurring or immediate work',
    );
  };
  const replacements = {
    setTimeout: (callback, delay, ...args) =>
      schedule('timer', callback, delay, undefined, args),
    clearTimeout: (id) => pending.delete(id),
    // Recurring work cannot quiesce into an honest static snapshot.
    setInterval: unsupported,
    clearInterval: (id) => pending.delete(id),
    setImmediate: unsupported,
    clearImmediate: (id) => pending.delete(id),
    queueMicrotask: (callback) =>
      schedule('render', callback, 0, undefined, []),
  };
  const originals = new Map(
    Object.keys(replacements).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  return {
    install() {
      for (const [name, value] of Object.entries(replacements))
        Object.defineProperty(globalThis, name, {
          configurable: true,
          writable: true,
          enumerable: originals.get(name)?.enumerable ?? true,
          value,
        });
    },
    render(callback, receiver) {
      schedule('render', callback, 0, receiver, []);
    },
    drain() {
      while (pending.size) {
        // Acknowledgements for the current render precede a timer frame.
        const [id, task] = [...pending.entries()].sort(
          ([aId, a], [bId, b]) =>
            a.due - b.due ||
            (a.kind === b.kind ? 0 : a.kind === 'render' ? -1 : 1) ||
            aId - bId,
        )[0];
        pending.delete(id);
        now = task.due;
        executed += 1;
        synchronous(task.callback, task.receiver, task.args);
      }
    },
    restore() {
      // Discard even callbacks queued by a failing detached hook. No real
      // timer has been allocated, and none may outlive this capture.
      pending.clear();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
    report: () => ({
      callbacksExecuted: executed,
      elapsedMs: now,
      pendingCallbacks: pending.size,
    }),
  };
}

export function nativeComponentPreviewCapture(
  definition,
  attributes,
  evaluate,
) {
  const properties = {};
  for (const [name, schema] of Object.entries(definition.properties ?? {})) {
    const attr = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (!(attr in attributes)) {
      properties[name] = structuredClone(schema.value);
      continue;
    }
    const raw = attributes[attr];
    let value = evaluate(raw);
    if (schema.type === Boolean && typeof value !== 'boolean')
      value = raw === '' || value === 'true';
    if (schema.type === Number) value = Number(value);
    properties[name] = structuredClone(value);
  }
  const scheduler = previewScheduler();
  const lifecycleEvents = [];
  const instance = {
    properties,
    data: { ...structuredClone(definition.data ?? {}), ...properties },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) scheduler.render(callback, this);
    },
    triggerEvent(name, detail, options) {
      if (name !== 'opened' && name !== 'closed')
        throw new Error('Preview initialization must not dispatch actions');
      // Recorded locally only. There is no owner callback or event dispatcher.
      lifecycleEvents.push(structuredClone({ name, detail, options }));
    },
  };
  for (const [name, method] of Object.entries(definition.methods ?? {}))
    instance[name] = method.bind(instance);
  let data;
  let failure;
  let failed = false;
  let attached = false;
  try {
    scheduler.install();
    attached = true;
    if (definition.lifetimes?.attached)
      synchronous(definition.lifetimes.attached, instance);
    scheduler.drain();
    // Detached legitimately invalidates native data. Preserve the settled
    // source projection, not a manually reconstructed "open" presentation.
    data = structuredClone(instance.data);
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    try {
      if (attached && definition.lifetimes?.detached)
        synchronous(definition.lifetimes.detached, instance);
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    } finally {
      scheduler.restore();
    }
  }
  if (failed) throw failure;
  return { data, lifecycleEvents, scheduler: scheduler.report() };
}

export function nativeComponentPreviewState(definition, attributes, evaluate) {
  return nativeComponentPreviewCapture(definition, attributes, evaluate).data;
}
