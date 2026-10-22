/** TEST ONLY: two exact producer import edges, never a global runtime fallback. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { ResolveHookSync } from 'node:module';
import type { RuntimeConfig } from '../../../src/config/config.js';
import { requireM1TestConfig } from './boundary.js';

const historicalProducer = new URL('./publication.service.ts', import.meta.url)
  .href;
const replyProducer = new URL(
  '../../../src/community/discussion/publication.service.ts',
  import.meta.url,
).href;
const currentHelper = new URL(
  '../../../src/community/text-source/publication.js',
  import.meta.url,
).href;
const savedHelper = new URL('./text-source-publication.ts', import.meta.url)
  .href;

export function m1ProducerImport(
  specifier: string,
  parentURL: string | undefined,
): string | undefined {
  if (parentURL !== historicalProducer && parentURL !== replyProducer)
    return undefined;
  return new URL(specifier, parentURL).href === currentHelper
    ? savedHelper
    : undefined;
}

export function m1ProducerResolver(
  mapped: (parent: string) => void,
): ResolveHookSync {
  return (specifier, context, nextResolve) => {
    const target = m1ProducerImport(specifier, context.parentURL);
    if (target === undefined) return nextResolve(specifier, context);
    const resolved = nextResolve(target, context);
    assert.equal(
      resolved.url,
      savedHelper,
      'M1 helper resolution changed unexpectedly',
    );
    mapped(context.parentURL!);
    return resolved;
  };
}

/** Install before dynamically importing the test composition. Node's test runner
 * isolates this file in its own process; deregistration also restores resolution
 * on failure. Existing current production/reader import edges are never mapped.
 */
export function installM1ProducerMapping(config: RuntimeConfig) {
  requireM1TestConfig(config);
  const mapped = new Set<string>();
  const hooks = registerHooks({
    resolve: m1ProducerResolver((parent) => mapped.add(parent)),
  });
  return Object.freeze({
    assertComplete() {
      assert.deepEqual(
        [...mapped].sort(),
        [historicalProducer, replyProducer].sort(),
        'M1 producers were preloaded or their exact import edges changed',
      );
    },
    deregister: () => hooks.deregister(),
  });
}
