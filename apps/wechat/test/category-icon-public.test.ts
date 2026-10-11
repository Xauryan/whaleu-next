import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  RatingScopedController,
  initialRatingScopedView,
} from '../src/ratings/scoped-controller';
import {
  decodeCategoryIconPublicContext,
  decodeCategoryIconPublicPage,
} from '../src/ratings/category-icon-public-contract';
import type { CategoryIconPublicGateway } from '../src/ratings/category-icon-public-gateway';
import type { CommunityRuntime } from '../src/community/runtime';
import { scopedHarness, scopedContext } from './rating-scoped-helpers';
import { category } from './ratings-helpers';
import { iconId } from './category-icon-helpers';
test('public context5 cannot be borrowed from target cover and never accepts provider URLs', () => {
  const base = scopedContext(),
    context = decodeCategoryIconPublicContext({
      ...base,
      id: iconId(90),
      protocolVersion: 5,
      mediaSnapshot: 'b'.repeat(64),
      capabilities: [...base.capabilities, 'category_icon'],
    });
  assert.throws(() =>
    decodeCategoryIconPublicContext({ ...context, protocolVersion: 3 }),
  );
  assert.throws(() =>
    decodeCategoryIconPublicContext({
      ...context,
      capabilities: ['target_cover'],
    }),
  );
  const page = {
    context: {
      contextId: context.id,
      selector: context.selector,
      catalogRevision: context.heads[0]!.catalogRevision,
      protocolGeneration: context.protocolGeneration,
      parentId: null,
    },
    items: [
      {
        ...category(),
        icon: {
          protocol: 'ratings-category-icon-media-v1',
          kind: 'ratings-category-icon-media',
          categoryId: category().id,
          appearanceId: iconId(91),
          bindingId: iconId(92),
          contextId: context.id,
          contextToken: context.token,
          width: 20,
          height: 20,
          variants: ['thumb-v1', 'display-v1'],
        },
      },
    ],
    nextCursor: null,
    continuation: 'end',
  };
  assert.doesNotThrow(() => decodeCategoryIconPublicPage(page));
  assert.throws(() =>
    decodeCategoryIconPublicPage({
      ...page,
      items: [
        {
          ...page.items[0],
          icon: { ...page.items[0]!.icon, url: 'https://provider.invalid' },
        },
      ],
    }),
  );
});
test('original public catalog uses independent icon context, sanitizes descriptors, and never downgrades unknown denial', async () => {
  const h = scopedHarness();
  h.controller.dispose();
  let view = initialRatingScopedView(),
    fail = false;
  const calls: string[] = [];
  const contextFor = (
    request: Parameters<CategoryIconPublicGateway['context']>[0],
  ) => {
    const base = scopedContext(request, h.clock.now());
    return decodeCategoryIconPublicContext({
      ...base,
      id: iconId(93),
      protocolVersion: 5,
      mediaSnapshot: 'b'.repeat(64),
      capabilities: [...base.capabilities, 'category_icon'],
    });
  };
  const gateway: CategoryIconPublicGateway = {
    entryContext: async (request) => {
      calls.push('entry5');
      if (fail)
        throw new ClientError('business', 'Unavailable', {
          serverCode: 'RATING_SCOPE_UNAVAILABLE',
        });
      return { kind: 'icon', context: contextFor(request) };
    },
    context: async (request) => contextFor(request),
    categories: async (context, parentId) => {
      calls.push('categories5');
      return decodeCategoryIconPublicPage({
        context: {
          contextId: context.id,
          selector: context.selector,
          catalogRevision: context.heads[0]!.catalogRevision,
          protocolGeneration: context.protocolGeneration,
          parentId,
        },
        items: [
          {
            ...category(),
            icon: {
              protocol: 'ratings-category-icon-media-v1',
              kind: 'ratings-category-icon-media',
              categoryId: category().id,
              appearanceId: iconId(91),
              bindingId: iconId(92),
              contextId: context.id,
              contextToken: context.token,
              width: 20,
              height: 20,
              variants: ['thumb-v1', 'display-v1'],
            },
          },
        ],
        nextCursor: null,
        continuation: 'end',
      });
    },
  };
  const runtime: CommunityRuntime = {
      ...h.runtime,
      ratingCategoryIconPublic: gateway,
    },
    controller = new RatingScopedController(
      runtime,
      (next) => {
        view = next;
      },
      h.clock,
    );
  try {
    await controller.load({ mode: 'catalog', scope: 'global' });
    assert.equal(view.loaded, true);
    assert.deepEqual(calls, ['entry5', 'categories5']);
    assert.equal(
      'hasIcon' in view.categories[0]! && view.categories[0]!.hasIcon,
      true,
    );
    assert.equal(JSON.stringify(view).includes('contextToken'), false);
    assert.equal(JSON.stringify(view).includes('bindingId'), false);
    assert.equal(h.gateway.calls.includes('categories'), false);
    fail = true;
    calls.length = 0;
    await controller.load({ mode: 'catalog', scope: 'global' });
    assert.equal(view.loaded, false);
    assert.deepEqual(calls, ['entry5']);
    assert.equal(h.gateway.calls.includes('categories'), false);
  } finally {
    controller.dispose();
  }
});
test('explicit server-negotiated legacy Category context preserves original non-media catalog', async () => {
  const h = scopedHarness();
  h.controller.dispose();
  let view = initialRatingScopedView();
  const gateway: CategoryIconPublicGateway = {
    entryContext: async (request) => ({
      kind: 'legacy',
      context: scopedContext(request, h.clock.now()),
    }),
    context: async () => {
      throw Error('No v5 capability');
    },
    categories: async () => {
      throw Error('No v5 category read');
    },
  };
  const controller = new RatingScopedController(
    { ...h.runtime, ratingCategoryIconPublic: gateway },
    (next) => {
      view = next;
    },
    h.clock,
  );
  try {
    await controller.load({ mode: 'catalog', scope: 'global' });
    assert.equal(view.loaded, true);
    assert.ok(h.gateway.calls.includes('categories'));
  } finally {
    controller.dispose();
  }
});
