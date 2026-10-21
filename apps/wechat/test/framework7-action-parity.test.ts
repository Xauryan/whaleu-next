import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
test('Input parity mapping changes only the actual native custom event boundary', () => {
  const node = {
    tag: 'wu-f7-input',
    attrs: {
      'bind:input': 'onDraft',
      'bind:confirm': 'onSubmit',
      value: '{{raw}}',
      disabled: '{{busy || denied}}',
      'data-id': '{{item.id}}',
      'wx:if': '{{allowed}}',
      maxlength: '-1',
      type: 'text',
    },
    children: ['safe text'],
  };
  const normalized = normalizeFramework7ActionNode(node);
  assert.deepEqual(normalized, {
    tag: 'input',
    attrs: {
      bindinput: 'onDraft',
      bindconfirm: 'onSubmit',
      value: '{{raw}}',
      disabled: '{{busy || denied}}',
      'data-id': '{{item.id}}',
      'wx:if': '{{allowed}}',
      maxlength: '-1',
      type: 'text',
    },
    children: ['safe text'],
  });
  assert.equal(node.attrs['bind:input'], 'onDraft');
});
test('unknown custom input and native permission controls never gain parity aliases', () => {
  const nodes: PresentationNode[] = [
    {
      tag: 'untrusted-input',
      attrs: { 'bind:input': 'onDraft' },
      children: [],
    },
    {
      tag: 'button',
      attrs: { 'open-type': 'getPhoneNumber', bindgetphonenumber: 'onPhone' },
      children: [],
    },
  ];
  for (const node of nodes)
    assert.equal(normalizeFramework7ActionNode(node), node);
});
