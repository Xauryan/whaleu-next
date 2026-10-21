/** Native editor contract shared by the input and searchbar ports.
 * The owner binds its draft to value and accepts input events without rewriting
 * an in-progress native editor buffer. This is not a DOM composition emulator.
 */
export const nativeEditorProperties = {
  value: { type: String, value: '' },
  placeholder: { type: String, value: '' },
  maxlength: { type: Number, value: 140 },
  disabled: { type: Boolean, value: false },
  readOnly: { type: Boolean, value: false },
  focus: { type: Boolean, value: false },
  confirmHold: { type: Boolean, value: false },
  adjustPosition: { type: Boolean, value: true },
  cursorSpacing: { type: Number, value: 0 },
  selectionStart: { type: Number, value: -1 },
  selectionEnd: { type: Number, value: -1 },
  clearable: { type: Boolean, value: false },
  ariaLabel: { type: String, value: '' },
};

export interface NativeEditorProperties {
  value: string;
  disabled: boolean;
  readOnly: boolean;
  clearable: boolean;
  maxlength: number;
  cursorSpacing: number;
  selectionStart: number;
  selectionEnd: number;
}
export interface NativeEditorInstance {
  properties: NativeEditorProperties;
  data: { mounted: boolean; pageVisible: boolean; focused: boolean };
  setData(data: Record<string, unknown>): void;
  triggerEvent(
    name: string,
    detail: unknown,
    options: { bubbles: boolean; composed: boolean },
  ): void;
}

const isolated = { bubbles: false, composed: false };
export function editorEnabled(instance: NativeEditorInstance) {
  return (
    instance.data.mounted &&
    instance.data.pageVisible &&
    !instance.properties.disabled &&
    !instance.properties.readOnly
  );
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}
function nativeDetail(event: unknown) {
  return record(record(event)?.detail);
}
export function nativeValue(event: unknown): string | null {
  const value = nativeDetail(event)?.value;
  return typeof value === 'string' ? value : null;
}
export function inputDetail(event: unknown) {
  const value = nativeValue(event);
  if (value === null) return null;
  const cursor = nativeDetail(event)?.cursor;
  return {
    value,
    ...(typeof cursor === 'number' && Number.isInteger(cursor) && cursor >= 0
      ? { cursor }
      : {}),
  };
}
export function editorPresentation(properties: NativeEditorProperties) {
  const maxlength = properties.maxlength;
  const start = properties.selectionStart;
  const end = properties.selectionEnd;
  // -1 is the native unlimited maxlength / no-selection sentinel. Zero stays
  // zero; an invalid value falls back to the native default, never unlimited.
  return {
    nativeMaxlength:
      Number.isInteger(maxlength) && maxlength >= -1 ? maxlength : 140,
    nativeCursorSpacing:
      Number.isFinite(properties.cursorSpacing) && properties.cursorSpacing >= 0
        ? properties.cursorSpacing
        : 0,
    nativeSelectionStart: Number.isInteger(start) && start >= -1 ? start : -1,
    nativeSelectionEnd: Number.isInteger(end) && end >= -1 ? end : -1,
  };
}
export function inputPresentation(
  type: unknown,
  password: boolean,
  confirm: unknown,
) {
  const nativeType =
    type === 'number' || type === 'digit' || type === 'idcard' ? type : 'text';
  return {
    // Native password supports text/number only. Fall back to masked text,
    // rather than silently rendering unmasked digit/idcard input.
    nativeType: password && nativeType !== 'number' ? 'text' : nativeType,
    nativeConfirmType:
      confirm === 'send' ||
      confirm === 'search' ||
      confirm === 'next' ||
      confirm === 'go'
        ? confirm
        : 'done',
  };
}
export const nativeEditorData = {
  mounted: false,
  pageVisible: true,
  focused: false,
  nativeMaxlength: 140,
  nativeCursorSpacing: 0,
  nativeSelectionStart: -1,
  nativeSelectionEnd: -1,
};
export const nativeEditorMethods = {
  onConsumeTap() {
    // Focusing a native editor must not also activate a containing row.
  },
  onInput(this: NativeEditorInstance, event: unknown) {
    if (!editorEnabled(this)) return;
    const detail = inputDetail(event);
    if (detail) this.triggerEvent('input', detail, isolated);
    // Deliberately return undefined. Native input handlers can replace the
    // editor buffer by returning a string, which can interrupt Chinese IME.
    // keyCode (including 229) is not a reliable composition/commit signal.
  },
  onFocus(this: NativeEditorInstance, event: unknown) {
    if (!editorEnabled(this)) return;
    this.setData({ focused: true });
    const height = nativeDetail(event)?.height;
    this.triggerEvent(
      'focus',
      typeof height === 'number' && Number.isFinite(height) && height >= 0
        ? { height }
        : {},
      isolated,
    );
  },
  onBlur(this: NativeEditorInstance, event: unknown) {
    if (!this.data.mounted) return;
    this.setData({ focused: false });
    if (!editorEnabled(this)) return;
    const value = nativeValue(event);
    if (value !== null) this.triggerEvent('blur', { value }, isolated);
  },
  onConfirm(this: NativeEditorInstance, event: unknown) {
    if (!editorEnabled(this)) return;
    const value = nativeValue(event);
    if (value !== null) this.triggerEvent('confirm', { value }, isolated);
  },
  onClear(this: NativeEditorInstance) {
    if (
      !editorEnabled(this) ||
      !this.properties.clearable ||
      !this.properties.value
    )
      return;
    // One proposal only: the owner handles clear and writes its draft. Do not
    // also emit input, clear the buffer, submit, or take keyboard focus.
    this.triggerEvent('clear', { value: '' }, isolated);
  },
};
export const nativeEditorPageLifetimes = {
  hide(this: NativeEditorInstance) {
    if (this.data.mounted) this.setData({ pageVisible: false, focused: false });
  },
  show(this: NativeEditorInstance) {
    if (this.data.mounted) this.setData({ pageVisible: true });
  },
};
