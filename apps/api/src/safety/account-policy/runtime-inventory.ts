import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import type { AccountRoutePolicy } from './routes.js';

export interface RegisteredAccountRoute {
  handler: string;
  method: string;
  path: string;
}
/** Inspect instantiated Nest modules and effective method metadata, including
 * applyDecorators, aliases, generated decorators and inherited handlers. */
export function registeredAccountRoutes(
  modules: ModulesContainer,
): RegisteredAccountRoute[] {
  const scanner = new MetadataScanner();
  const result: RegisteredAccountRoute[] = [];
  const paths = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value) && value.every((part) => typeof part === 'string'))
      return value;
    throw new Error('Unsupported registered controller path');
  };
  for (const module of modules.values())
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      const instance = wrapper.instance as object | undefined;
      if (!controller || !instance)
        throw new Error('Unresolved registered controller');
      const prefix = paths(Reflect.getMetadata(PATH_METADATA, controller));
      const prototype = Object.getPrototypeOf(instance) as Record<
        string,
        unknown
      >;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const method = prototype[name];
        if (typeof method !== 'function') continue;
        const verb = Reflect.getMetadata(METHOD_METADATA, method) as
          RequestMethod | undefined;
        if (verb === undefined) continue;
        const suffix = paths(Reflect.getMetadata(PATH_METADATA, method));
        for (const p of prefix)
          for (const s of suffix)
            result.push({
              handler: `${controller.name}.${name}`,
              method: RequestMethod[verb],
              path:
                '/' +
                [p, s]
                  .flatMap((part) => part.split('/'))
                  .filter(Boolean)
                  .join('/'),
            });
      }
    }
  return result.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
export function assertAccountRouteManifest(
  modules: ModulesContainer,
  policies: readonly AccountRoutePolicy[],
): RegisteredAccountRoute[] {
  const routes = registeredAccountRoutes(modules);
  const actual = new Set<string>(),
    expected = new Set<string>(),
    endpoints = new Set<string>();
  const key = (handler: string, method: string, path: string) =>
    JSON.stringify([handler, method, path]);
  for (const route of routes) {
    const id = key(route.handler, route.method, route.path),
      endpoint = `${route.method} ${route.path}`;
    if (actual.has(id) || endpoints.has(endpoint))
      throw new Error(`Duplicate registered account route: ${id}`);
    actual.add(id);
    endpoints.add(endpoint);
  }
  for (const [handler, method, path] of policies) {
    const id = key(handler, method, path);
    if (expected.has(id))
      throw new Error(`Duplicate semantic account route: ${id}`);
    expected.add(id);
  }
  const missing = [...actual].filter((id) => !expected.has(id));
  const stale = [...expected].filter((id) => !actual.has(id));
  if (missing.length || stale.length)
    throw new Error(
      `Account route inventory mismatch; missing=${missing.join(';')} stale=${stale.join(';')}`,
    );
  return routes;
}
