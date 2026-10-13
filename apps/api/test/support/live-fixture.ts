/** Compose fixture extensions without evaluating app/server lifecycle accessors.
 * Object spread snapshots getters, silently keeping a closed pre-upgrade app. */
export function extendLiveFixture<
  Base extends object,
  Extension extends object,
>(base: Base, extension: Extension): Omit<Base, keyof Extension> & Extension {
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(base),
      ...Object.getOwnPropertyDescriptors(extension),
    },
  ) as Omit<Base, keyof Extension> & Extension;
}
