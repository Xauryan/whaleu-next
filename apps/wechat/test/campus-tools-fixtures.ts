import {
  TOOL_CATALOG_VERSION,
  type EnabledToolEntry,
  type ToolDetail,
  type ToolHub,
  type ToolLink,
  type ToolLinkPolicy,
  type ToolMediaSlot,
} from '../src/campus-tools/contract';
import type { ToolGateway } from '../src/campus-tools/gateway';
export const campusId = '11111111-1111-4111-8111-111111111111',
  catalogId = '22222222-2222-4222-8222-222222222222',
  entryId = '33333333-3333-4333-8333-333333333333',
  revision = '44444444-4444-4444-8444-444444444444';
export const route = { campusId, catalogId, entryId };
export const digest = 'a'.repeat(64);
export const policy: ToolLinkPolicy = {
  id: '55555555-5555-4555-8555-555555555555',
  version: 1,
  rules: [
    { action: 'copy', host: 'tools.example.com', path: '/resource', query: [] },
    {
      action: 'webview',
      host: 'tools.example.com',
      path: '/controlled',
      query: [],
    },
  ],
};
export const slot: ToolMediaSlot = {
  id: 'introduction',
  bindingId: '66666666-6666-4666-8666-666666666666',
  assetId: '77777777-7777-4777-8777-777777777777',
  manifestDigest: 'b'.repeat(64),
  alt: '合成资料图片',
};
const base = {
  id: entryId,
  sourceId: 'synthetic',
  ordinal: 0,
  revision,
  title: '合成校园工具',
  state: 'enabled' as const,
};
export function entry(
  kind: EnabledToolEntry['kind'] = 'map',
): EnabledToolEntry {
  if (kind === 'map')
    return {
      ...base,
      kind,
      coordinateSystem: 'gcj02',
      center: { latitude: 40, longitude: 116 },
      zoom: 16,
      markers: [
        {
          id: 6,
          sourceId: 'synthetic_marker',
          title: '合成地点',
          category: '地点',
          details: '合成描述，不代表当前真实校园数据',
          position: { latitude: 40.001, longitude: 116.001 },
        },
      ],
    };
  if (kind === 'research')
    return {
      ...base,
      kind,
      description: '合成科研资源',
      compatibility: null,
      image: slot,
      link: { action: 'copy', state: 'available' },
    };
  if (kind === 'web-link')
    return { ...base, kind, link: { action: 'webview', state: 'available' } };
  return {
    ...base,
    kind,
    groups: [
      { id: 'shuttle', title: '摆渡车', slots: [slot] },
      {
        id: 'bus',
        title: '校车',
        slots: [
          {
            ...slot,
            id: 'second',
            bindingId: '88888888-8888-4888-8888-888888888888',
            assetId: '99999999-9999-4999-8999-999999999999',
          },
        ],
      },
    ],
  };
}
export function detail(
  value = entry(),
): Extract<ToolDetail, { state: 'ready' }> {
  return {
    state: 'ready',
    campusId,
    catalogId,
    digest,
    version: TOOL_CATALOG_VERSION,
    provenance: {
      maintainer: '合成维护者',
      attribution: '合成来源',
      observedAt: '2026-10-14T00:00:00Z',
      publishedAt: '2026-10-14T00:00:00Z',
      validity: {
        kind: 'policy_exempt',
        effectiveAt: '2026-10-14T00:00:00Z',
        exemptionReference: 'synthetic-policy',
      },
    },
    entry: value,
  };
}
export function hub(value = entry()): ToolHub {
  const { entry: item, ...context } = detail(value);
  return { ...context, entries: [item] };
}
export function link(action: 'copy' | 'webview' = 'copy'): ToolLink {
  return {
    state: 'ready',
    ...route,
    digest,
    entryRevision: revision,
    action,
    url:
      action === 'copy'
        ? 'https://tools.example.com/resource'
        : 'https://tools.example.com/controlled',
    policy,
  };
}
export function gateway(value = entry()): ToolGateway {
  return {
    hub: async () => hub(value),
    detail: async () => detail(value),
    link: async (_, action) => link(action),
  };
}
