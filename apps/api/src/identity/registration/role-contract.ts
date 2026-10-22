/** Additional read-gate privileges only; no provisioning or production grants.
 * The migrator's shared advisory gate needs no new table privileges. Named UPDATE
 * columns are PostgreSQL's minimum for the existing FOR SHARE row reads;
 * write-closed triggers still deny all actual mutation. */
export const registrationGuardTablePrivileges = Object.freeze(
  [
    'registration_guard_policy',
    'registration_guard_key_epochs',
    'registration_guards',
  ].map((table) =>
    Object.freeze({
      relation: `whaleu_identity.${table}`,
      privilege: 'SELECT',
    }),
  ),
);
export const registrationGuardColumnPrivileges = Object.freeze([
  Object.freeze({
    relation: 'whaleu_identity.registration_guard_policy',
    column: 'slot',
    privilege: 'UPDATE',
  }),
  Object.freeze({
    relation: 'whaleu_identity.registration_guard_key_epochs',
    column: 'epoch',
    privilege: 'UPDATE',
  }),
]);
export const registrationGuardFunctionPrivileges = Object.freeze([
  'whaleu_identity.registration_guard_catalog()',
]);
