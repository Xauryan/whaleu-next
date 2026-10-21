/** Native overlay lifecycle adaptation of Framework7 v9.2.0 (MIT).
 * Copyright (c) 2014 Vladimir Kharlampidi.
 * See docs/vendor/framework7-v9.2.0/LICENSE.
 * UI identities are not domain request IDs. This helper cannot pause readers,
 * authorize mutations, restore focus, or promise native stacking correctness.
 */
export const isolated = { bubbles: false, composed: false };
export const overlayProperties = {
  open: { type: Boolean, value: false },
  sessionId: { type: String, value: '' },
  disabled: { type: Boolean, value: false },
  loading: { type: Boolean, value: false },
  attemptKey: { type: Number, value: 0 },
  keyboardHeight: { type: Number, value: 0 },
  safeAreaBottom: { type: Boolean, value: true },
};
export const overlayData = {
  mounted: false,
  pageVisible: true,
  rendered: false,
  phase: 'closed',
  activeSessionId: '',
  generation: 0,
  renderKeys: [] as { generation: number }[],
  editorKeys: [] as { key: string }[],
  visible: false,
  intentPending: false,
  interactionDisabled: true,
  keyboardInset: 0,
  useSafeArea: true,
  editorFocused: false,
  buttonInteractionKey: '',
};
export interface OverlayInstance {
  properties: {
    open: boolean;
    sessionId: string;
    disabled: boolean;
    loading: boolean;
    attemptKey: number;
    keyboardHeight: number;
    safeAreaBottom: boolean;
    focus?: boolean;
    mode?: string;
    confirmId?: string;
  };
  data: typeof overlayData;
  setData(data: Record<string, unknown>, callback?: () => void): void;
  triggerEvent(name: string, detail: unknown, options: typeof isolated): void;
}
interface OverlayState {
  mounted: boolean;
  visible: boolean;
  sessionId: string;
  suppressedSessionId: string;
  generation: number;
  duration: number;
  phase: 'closed' | 'opening' | 'open' | 'closing';
  pending: boolean;
  attemptKey: number | null;
  timers: Set<ReturnType<typeof setTimeout>>;
}
const states = new WeakMap<object, OverlayState>();
export function validSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value)
  );
}
export function validActionId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
  );
}
export function validAttemptKey(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function clearTimers(state: OverlayState) {
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
}
function current(
  instance: OverlayInstance,
  state: OverlayState,
  generation: number,
) {
  return (
    states.get(instance) === state &&
    state.mounted &&
    state.visible &&
    state.generation === generation
  );
}
function later(
  instance: OverlayInstance,
  state: OverlayState,
  delay: number,
  callback: () => void,
) {
  const generation = state.generation;
  const timer = setTimeout(() => {
    state.timers.delete(timer);
    if (current(instance, state, generation)) callback();
  }, delay);
  state.timers.add(timer);
}
export function overlayIdentity(instance: OverlayInstance) {
  const state = states.get(instance);
  return {
    sessionId: state?.sessionId ?? '',
    generation: state?.generation ?? 0,
  };
}
export function overlayButtonInteractionKey(instance: OverlayInstance) {
  const state = states.get(instance);
  if (!state) return '';
  const sessionId = state.sessionId;
  const mode = ['alert', 'confirm', 'prompt'].includes(
    instance.properties.mode ?? '',
  )
    ? instance.properties.mode!
    : '';
  const confirmId = validActionId(instance.properties.confirmId)
    ? instance.properties.confirmId
    : '';
  // Length prefixes disambiguate permitted ':' characters in UI session IDs.
  // Confirm identity participates so an old Save tap cannot become Delete.
  return `${sessionId.length}:${sessionId}:${state.generation}:${state.attemptKey ?? -1}:${mode.length}:${mode}:${confirmId.length}:${confirmId}`;
}
function project(instance: OverlayInstance, state: OverlayState) {
  if (!state.mounted) return;
  const rawHeight = instance.properties.keyboardHeight;
  // A finite upper bound prevents arbitrary interpolated style or absurd viewport offsets.
  const keyboardInset =
    Number.isFinite(rawHeight) && rawHeight >= 0
      ? Math.min(rawHeight, 2000)
      : 0;
  const interactionDisabled =
    state.phase !== 'open' ||
    state.pending ||
    instance.properties.disabled ||
    instance.properties.loading ||
    !validAttemptKey(instance.properties.attemptKey) ||
    instance.properties.attemptKey !== state.attemptKey;
  instance.setData({
    interactionDisabled,
    buttonInteractionKey: overlayButtonInteractionKey(instance),
    intentPending: state.pending,
    keyboardInset,
    useSafeArea: instance.properties.safeAreaBottom && keyboardInset === 0,
    editorFocused:
      !interactionDisabled &&
      instance.properties.mode === 'prompt' &&
      instance.properties.focus === true,
  });
}
function startOpen(instance: OverlayInstance, state: OverlayState) {
  clearTimers(state);
  state.generation += 1;
  const generation = state.generation;
  state.sessionId = instance.properties.sessionId;
  state.phase = 'opening';
  state.pending = false;
  state.attemptKey = validAttemptKey(instance.properties.attemptKey)
    ? instance.properties.attemptKey
    : null;
  instance.setData(
    {
      rendered: true,
      visible: false,
      phase: 'opening',
      activeSessionId: state.sessionId,
      generation,
      renderKeys: [{ generation }],
      editorKeys: [{ key: `${generation}:${state.attemptKey ?? 'invalid'}` }],
    },
    () => {
      if (!current(instance, state, generation) || state.phase !== 'opening')
        return;
      // Mount acknowledgement, then a separate animated frame. Native input
      // subtree keys change only on an opening, never during cursor/IME edits.
      later(instance, state, 16, () => {
        if (
          !instance.properties.open ||
          instance.properties.sessionId !== state.sessionId ||
          state.phase !== 'opening'
        )
          return;
        instance.setData({ visible: true }, () => {
          if (
            !current(instance, state, generation) ||
            state.phase !== 'opening'
          )
            return;
          later(instance, state, state.duration, () => {
            if (
              !instance.properties.open ||
              instance.properties.sessionId !== state.sessionId ||
              state.phase !== 'opening'
            )
              return;
            state.phase = 'open';
            instance.setData({ phase: 'open' });
            project(instance, state);
            instance.triggerEvent(
              'opened',
              overlayIdentity(instance),
              isolated,
            );
          });
        });
      });
    },
  );
  project(instance, state);
}
function startClose(instance: OverlayInstance, state: OverlayState) {
  if (state.phase === 'closed' || state.phase === 'closing') return;
  clearTimers(state);
  state.phase = 'closing';
  const generation = state.generation;
  instance.setData(
    { visible: false, phase: 'closing', editorFocused: false },
    () => {
      if (!current(instance, state, generation) || state.phase !== 'closing')
        return;
      later(instance, state, state.duration, () => {
        if (state.phase !== 'closing') return;
        // A newer opening cancels this generation before reaching this callback.
        if (
          instance.properties.open &&
          validSessionId(instance.properties.sessionId)
        )
          return;
        const identity = overlayIdentity(instance);
        state.phase = 'closed';
        state.pending = false;
        instance.setData(
          {
            rendered: false,
            renderKeys: [],
            editorKeys: [],
            phase: 'closed',
            visible: false,
            editorFocused: false,
          },
          () => {
            // Parent must not resume readers until native removal is acknowledged.
            // Hide, detach, or reopen between timeout and renderer ack cancels it.
            if (
              current(instance, state, generation) &&
              state.phase === 'closed'
            )
              instance.triggerEvent('closed', identity, isolated);
          },
        );
        project(instance, state);
      });
    },
  );
  project(instance, state);
}
export function syncOverlay(instance: OverlayInstance) {
  const state = states.get(instance);
  if (!state?.mounted || !state.visible) return;
  const wantsOpen =
    instance.properties.open &&
    validSessionId(instance.properties.sessionId) &&
    instance.properties.sessionId !== state.suppressedSessionId;
  if (
    wantsOpen &&
    (state.phase === 'closed' ||
      state.phase === 'closing' ||
      state.sessionId !== instance.properties.sessionId)
  )
    startOpen(instance, state);
  else if (!wantsOpen) startClose(instance, state);
  project(instance, state);
}
export function syncOverlayGuards(instance: OverlayInstance) {
  const state = states.get(instance);
  if (!state?.mounted) return;
  const attemptKey = instance.properties.attemptKey;
  if (validAttemptKey(attemptKey) && attemptKey > (state.attemptKey ?? -1)) {
    // Explicit attempt acknowledgement only. Invalid values never reset this latch.
    state.attemptKey = attemptKey;
    state.pending = false;
    if (state.visible && (state.phase === 'open' || state.phase === 'opening'))
      instance.setData({
        editorKeys: [{ key: `${state.generation}:${attemptKey}` }],
      });
  }
  project(instance, state);
}
export function eventDataset(event: unknown): Record<string, unknown> | null {
  if (!event || typeof event !== 'object') return null;
  const currentTarget = (event as { currentTarget?: unknown }).currentTarget;
  if (!currentTarget || typeof currentTarget !== 'object') return null;
  const dataset = (currentTarget as { dataset?: unknown }).dataset;
  return dataset && typeof dataset === 'object'
    ? (dataset as Record<string, unknown>)
    : null;
}
export function overlayInteractive(instance: OverlayInstance, event: unknown) {
  const state = states.get(instance);
  const dataset = eventDataset(event);
  return (
    !!state &&
    current(instance, state, state.generation) &&
    state.phase === 'open' &&
    !state.pending &&
    !instance.properties.disabled &&
    !instance.properties.loading &&
    instance.properties.open &&
    instance.properties.sessionId === state.sessionId &&
    validAttemptKey(instance.properties.attemptKey) &&
    instance.properties.attemptKey === state.attemptKey &&
    dataset?.sessionId === state.sessionId &&
    dataset.generation === state.generation &&
    dataset.attemptKey === state.attemptKey
  );
}
export function emitOverlayIntent(
  instance: OverlayInstance,
  event: unknown,
  name: 'requestclose' | 'action',
  detail: { reason: 'backdrop' | 'cancel' | 'close' } | { id: string },
) {
  if (!overlayInteractive(instance, event)) return;
  const state = states.get(instance)!;
  state.pending = true; // Latch before synchronous owner callbacks.
  project(instance, state);
  instance.triggerEvent(
    name,
    {
      ...overlayIdentity(instance),
      attemptKey: state.attemptKey,
      ...detail,
    },
    isolated,
  );
}
export function emitOverlayButtonIntent(
  instance: OverlayInstance,
  event: unknown,
  name: 'requestclose' | 'action',
  detail: { reason: 'backdrop' | 'cancel' | 'close' } | { id: string },
) {
  if (!event || typeof event !== 'object') return;
  const press = (event as { detail?: { interactionKey?: unknown } }).detail;
  // The child's real native button captured this key before re-emitting press.
  // Host currentTarget datasets alone can relabel a queued old native tap.
  if (press?.interactionKey !== overlayButtonInteractionKey(instance)) return;
  emitOverlayIntent(instance, event, name, detail);
}
function dispose(instance: OverlayInstance, detached: boolean) {
  const state = states.get(instance);
  if (!state?.mounted) return;
  clearTimers(state);
  state.generation += 1;
  state.suppressedSessionId = state.sessionId || instance.properties.sessionId;
  state.phase = 'closed';
  state.visible = false;
  state.pending = false;
  if (detached) {
    state.mounted = false;
    // Do not write to a detached renderer. Still invalidate local projections.
    Object.assign(instance.data, {
      mounted: false,
      pageVisible: false,
      rendered: false,
      renderKeys: [],
      editorKeys: [],
      visible: false,
      phase: 'closed',
      editorFocused: false,
      interactionDisabled: true,
      intentPending: false,
    });
    return;
  }
  instance.setData({
    pageVisible: false,
    rendered: false,
    renderKeys: [],
    editorKeys: [],
    visible: false,
    phase: 'closed',
    editorFocused: false,
    interactionDisabled: true,
    intentPending: false,
  });
}
export function overlayLifecycle(duration: 300 | 400) {
  return {
    observers: {
      'open, sessionId'(this: OverlayInstance) {
        syncOverlay(this);
      },
      'disabled, loading, attemptKey, keyboardHeight, safeAreaBottom, focus, mode, confirmId'(
        this: OverlayInstance,
      ) {
        syncOverlayGuards(this);
      },
    },
    lifetimes: {
      attached(this: OverlayInstance) {
        const previous = states.get(this);
        states.set(this, {
          mounted: true,
          visible: true,
          sessionId: '',
          suppressedSessionId: '',
          generation: previous?.generation ?? 0,
          duration,
          phase: 'closed',
          pending: false,
          attemptKey: null,
          timers: new Set(),
        });
        this.setData({ mounted: true, pageVisible: true });
        syncOverlay(this);
      },
      detached(this: OverlayInstance) {
        dispose(this, true);
      },
    },
    pageLifetimes: {
      hide(this: OverlayInstance) {
        dispose(this, false);
      },
      show(this: OverlayInstance) {
        const state = states.get(this);
        if (!state?.mounted) return;
        state.visible = true;
        this.setData({ pageVisible: true });
        syncOverlay(this);
      },
    },
  };
}
