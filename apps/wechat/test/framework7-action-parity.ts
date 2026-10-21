import assert from 'node:assert/strict';

export interface PresentationNode {
  tag: string;
  attrs: Record<string, string>;
  children: (PresentationNode | string)[];
}

/**
 * Normalize only the deliberately migrated native component event boundary.
 * Datasets, loading/disabled properties, input events, navigation targets and
 * every conditional/loop scope are copied unchanged, never discarded.
 */
export function normalizeFramework7ActionNode(
  node: PresentationNode,
): PresentationNode {
  if (
    ['wu-f7-button', 'wu-f7-list-item'].includes(node.tag) &&
    node.attrs['bind:press']
  ) {
    const { ['bind:press']: press, ...attrs } = node.attrs;
    return { ...node, tag: 'button', attrs: { ...attrs, bindtap: press } };
  }
  if (node.tag === 'wu-f7-searchbar') {
    const {
      ['bind:input']: input,
      ['bind:confirm']: confirm,
      ...attrs
    } = node.attrs;
    return {
      ...node,
      tag: 'input',
      attrs: {
        ...attrs,
        ...(input ? { bindinput: input } : {}),
        ...(confirm ? { bindconfirm: confirm } : {}),
        'confirm-type': 'search',
      },
    };
  }
  if (node.tag === 'wu-f7-input') {
    const {
      ['bind:input']: input,
      ['bind:confirm']: confirm,
      ...attrs
    } = node.attrs;
    return {
      ...node,
      tag: 'input',
      attrs: {
        ...attrs,
        ...(input ? { bindinput: input } : {}),
        ...(confirm ? { bindconfirm: confirm } : {}),
      },
    };
  }
  if (node.tag === 'wu-f7-toggle' && node.attrs['bind:change']) {
    const { ['bind:change']: change, ...attrs } = node.attrs;
    return { ...node, tag: 'switch', attrs: { ...attrs, bindchange: change } };
  }
  if (
    node.tag === 'wu-f7-segmented' &&
    node.attrs['bind:change'] === 'onKindSegment'
  ) {
    // This is the sole page-local adapter. Separate runtime tests verify its
    // bounded option set, delegated original handler and lack of local state.
    assert.equal(node.attrs.options, '{{directorySegmentOptions}}');
    assert.equal(node.attrs.value, '{{kind}}');
    assert.equal(node.attrs.disabled, undefined);
    const attrs = { ...node.attrs };
    delete attrs['bind:change'];
    return {
      ...node,
      tag: 'button',
      attrs: {
        ...attrs,
        'wx:for': '{{directoryKinds}}',
        'wx:key': '*this',
        'data-kind': '{{item}}',
        bindtap: 'onKind',
      },
    };
  }
  return node;
}
