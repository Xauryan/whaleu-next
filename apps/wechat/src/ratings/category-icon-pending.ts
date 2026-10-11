import { sha256 } from 'js-sha256';
import type { SessionStore } from '../auth/session';
import { ClientError, isRecord } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import {
  canonicalRatingScopedJson,
  ratingScopedDigest,
} from './scoped-contract';
import {
  decodeRatingCategoryScopedIntent,
  ratingCategoryScopedOperations,
  type RatingCategoryScopedIntent,
  type RatingCategoryScopedOperation,
} from './category-scoped-contract';
import {
  categoryIconTextIntent,
  decodeRatingCategoryIconIntent,
  decodeRatingCategoryIconReceipt,
  matchRatingCategoryIconReceipt,
  ratingCategoryIconIntentHash,
  type RatingCategoryIconIntent,
  type RatingCategoryIconReceipt,
} from './category-icon-contract';
import {
  decodeCategoryIconMediaStatus,
  decodeCategoryIconPrepare,
  categoryIconPrepareHash,
  type CategoryIconMediaStatus,
  type CategoryIconPrepare,
} from './category-icon-media-contract';
import {
  categoryIconPrepareForScope,
  categoryIconScopeRequestHash,
  decodeCategoryIconScope,
  decodeCategoryIconScopeInput,
  decodeCategoryIconScopeRecovery,
  type CategoryIconScope,
  type CategoryIconScopeInput,
  type CategoryIconScopeRecovery,
  type CategoryIconSlot,
} from './category-icon-upload-scope';

export type CategoryIconDraftSelection =
  'keep' | 'clear' | 'inherit' | 'set-empty' | 'replace';
export interface CategoryIconDraftSlot {
  readonly key: string;
  readonly kind: 'base' | 'override';
  readonly campusId: string | null;
  readonly categoryId: string | null;
  readonly nodeKey: string | null;
  readonly selection: CategoryIconDraftSelection;
}
export interface RatingCategoryIconUploadIdentity {
  readonly draftRevision: string;
  readonly textIntent: RatingCategoryScopedIntent;
  readonly mediaSnapshot: string;
  readonly slots: readonly CategoryIconDraftSlot[];
}
/** Each member is saved before its owner-scope effect. Scope and Media prepare
 * remain null until the server returns the original scope; no asset is invented. */
export interface RatingCategoryIconUploadMember {
  readonly memberId: string;
  readonly slotKey: string;
  readonly scopeInput: CategoryIconScopeInput;
  readonly scope: CategoryIconScope | null;
  readonly prepare: CategoryIconPrepare | null;
  readonly status: CategoryIconMediaStatus | null;
  readonly state: 'pending' | 'unknown' | 'ready' | 'retiring' | 'retired';
  readonly assetId: string | null;
}
export interface PendingRatingCategoryIconUploads {
  readonly version: 13;
  readonly phase: 'uploads';
  readonly accountId: string;
  readonly identity: RatingCategoryIconUploadIdentity;
  readonly identityHash: string;
  readonly members: readonly RatingCategoryIconUploadMember[];
}
export interface CategoryIconUploadObligation {
  readonly memberId: string;
  readonly slotKey: string;
  readonly clientRequestId: string;
  readonly scopeRequestHash: string;
  readonly scope: Omit<CategoryIconScope, 'expiresAt'> | null;
  readonly requestHash: string | null;
  readonly assetId: string | null;
  readonly selected: boolean;
}
export interface PendingRatingCategoryIconCommand {
  readonly version: 13;
  readonly phase: 'command';
  readonly accountId: string;
  readonly intent: RatingCategoryIconIntent;
  readonly identityHash: string | null;
  readonly obligations: readonly CategoryIconUploadObligation[];
  readonly receipt: RatingCategoryIconReceipt | null;
}
export interface OpaqueRatingCategoryIconUploads {
  readonly version: 13;
  readonly phase: 'uploads-opaque';
  readonly accountId: string;
  readonly commandRequestId: string;
  readonly identityHash: string;
  readonly obligations: readonly CategoryIconUploadObligation[];
}
export interface OpaqueRatingCategoryIconCommand {
  readonly version: 13;
  readonly phase: 'command-opaque';
  readonly accountId: string;
  readonly requestId: string;
  readonly operation: RatingCategoryScopedOperation;
  readonly intentHash: string;
  readonly identityHash: string | null;
  readonly obligations: readonly CategoryIconUploadObligation[];
  readonly receipt: RatingCategoryIconReceipt | null;
}
export interface OpaqueRatingCategoryIconRecovery {
  readonly uploads: OpaqueRatingCategoryIconUploads | null;
  readonly command: OpaqueRatingCategoryIconCommand | null;
}
/** Receipt lookup must precede these member recoveries. Unknown is not a
 * cancellation; even a terminal Media result needs confirmed server cleanup. */
export interface CategoryIconUploadSettlement {
  readonly clientRequestId: string;
  readonly scopeRequestHash: string;
  readonly response: CategoryIconScopeRecovery;
}
const same = (a: unknown, b: unknown): boolean =>
  canonicalRatingScopedJson(a) === canonicalRatingScopedJson(b);
const unavailable = (): ClientError =>
  new ClientError(
    'storage',
    'Recover the original Ratings category icon request first',
  );
function id(value: unknown): string {
  if (!ratingId(value)) invalidRating();
  return value;
}
function digest(value: unknown): string {
  if (!ratingScopedDigest(value)) invalidRating();
  return value;
}
function nodeKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(value))
    invalidRating();
  return value;
}
function slotKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:new:[a-z][a-z0-9_]{0,31}|base:[0-9a-f-]{36}|override:[0-9a-f-]{36}:[0-9a-f-]{36})$/.test(
      value,
    )
  )
    invalidRating();
  return value;
}
/** Deterministic UI identity never substitutes a draft key for a Category ID. */
export function ratingCategoryIconSlotKey(slot: CategoryIconSlot): string {
  if (slot.kind === 'new') return `new:${nodeKey(slot.key)}`;
  if (slot.kind === 'base') return `base:${id(slot.categoryId)}`;
  return `override:${id(slot.categoryId)}:${id(slot.campusId)}`;
}
export function ratingCategoryIconSlotLayout(
  raw: RatingCategoryScopedIntent,
): readonly Omit<CategoryIconDraftSlot, 'selection'>[] {
  const text = decodeRatingCategoryScopedIntent(raw);
  const fresh = (key: string): Omit<CategoryIconDraftSlot, 'selection'> => ({
    key: `new:${key}`,
    kind: 'base',
    campusId: null,
    categoryId: null,
    nodeKey: key,
  });
  switch (text.operation) {
    case 'create_categories_scoped':
      return text.payload.nodes.map((node) => fresh(node.key));
    case 'batch_update_subcategories_scoped':
      return text.payload.addNodes.map((node) => fresh(node.key));
    case 'create_system_category_scoped':
      return [fresh('root')];
    case 'edit_category_base_scoped':
      return [
        {
          key: `base:${text.payload.categoryId}`,
          kind: 'base',
          campusId: null,
          categoryId: text.payload.categoryId,
          nodeKey: null,
        },
      ];
    case 'set_category_override_scoped':
      if (text.context.selector.kind !== 'campus') invalidRating();
      return [
        {
          key: `override:${text.payload.categoryId}:${text.context.selector.campusId}`,
          kind: 'override',
          campusId: text.context.selector.campusId,
          categoryId: text.payload.categoryId,
          nodeKey: null,
        },
      ];
    default:
      return [];
  }
}
export function decodeRatingCategoryIconUploadIdentity(
  raw: unknown,
): RatingCategoryIconUploadIdentity {
  exact(raw, ['draftRevision', 'textIntent', 'mediaSnapshot', 'slots']);
  if (!Array.isArray(raw.slots) || raw.slots.length > 32) invalidRating();
  const textIntent = decodeRatingCategoryScopedIntent(raw.textIntent),
    layout = ratingCategoryIconSlotLayout(textIntent);
  if (raw.slots.length !== layout.length) invalidRating();
  const slots = raw.slots.map((item: unknown, index: number) => {
    exact(item, [
      'key',
      'kind',
      'campusId',
      'categoryId',
      'nodeKey',
      'selection',
    ]);
    const { selection, ...binding } = item;
    if (!same(binding, layout[index])) invalidRating();
    const choices =
      item.kind === 'override'
        ? ['keep', 'inherit', 'set-empty', 'replace']
        : item.nodeKey === null
          ? ['keep', 'clear', 'replace']
          : ['clear', 'replace'];
    if (typeof selection !== 'string' || !choices.includes(selection))
      invalidRating();
    return Object.freeze({
      ...layout[index]!,
      selection: selection as CategoryIconDraftSelection,
    });
  });
  return Object.freeze({
    draftRevision: id(raw.draftRevision),
    textIntent,
    mediaSnapshot: digest(raw.mediaSnapshot),
    slots: Object.freeze(slots),
  });
}
export function ratingCategoryIconUploadIdentityHash(
  actor: string,
  raw: RatingCategoryIconUploadIdentity,
): string {
  return sha256(
    'whaleu:ratings-category-icon-uploads:v1\n' +
      canonicalRatingScopedJson({
        accountId: id(actor),
        identity: decodeRatingCategoryIconUploadIdentity(raw),
      }),
  );
}
export function decodeRatingCategoryIconUploadMember(
  raw: unknown,
  actor: string,
): RatingCategoryIconUploadMember {
  exact(raw, [
    'memberId',
    'slotKey',
    'scopeInput',
    'scope',
    'prepare',
    'status',
    'state',
    'assetId',
  ]);
  const scopeInput = decodeCategoryIconScopeInput(raw.scopeInput),
    scope = raw.scope === null ? null : decodeCategoryIconScope(raw.scope),
    prepare =
      raw.prepare === null ? null : decodeCategoryIconPrepare(raw.prepare),
    status =
      raw.status === null ? null : decodeCategoryIconMediaStatus(raw.status),
    assetId = raw.assetId === null ? null : id(raw.assetId);
  if (
    !['pending', 'unknown', 'ready', 'retiring', 'retired'].includes(
      String(raw.state),
    ) ||
    raw.slotKey !== ratingCategoryIconSlotKey(scopeInput.slot) ||
    scopeInput.clientRequestId === scopeInput.payload.clientRequestId ||
    (scope === null) !== (prepare === null) ||
    (scope && !same(prepare, categoryIconPrepareForScope(scopeInput, scope))) ||
    (status &&
      (!prepare ||
        status.requestId !== scopeInput.clientRequestId ||
        status.editScopeId !== prepare.editScopeId ||
        status.requestHash !== categoryIconPrepareHash(actor, prepare))) ||
    ((raw.state === 'pending' || raw.state === 'unknown') &&
      assetId !== null) ||
    (raw.state === 'ready' &&
      (status?.status !== 'ready_unbound' || assetId !== status.assetId)) ||
    (assetId !== null && !scope) ||
    (status?.status === 'ready_unbound' && assetId !== status.assetId) ||
    (status?.status === 'bound_history' &&
      (assetId !== status.assetId ||
        status.categoryId !== scope?.categoryId)) ||
    (raw.state === 'retired' &&
      (status?.status !== 'terminal' || status.cleanup !== 'confirmed'))
  )
    invalidRating();
  return Object.freeze({
    memberId: id(raw.memberId),
    slotKey: slotKey(raw.slotKey),
    scopeInput,
    scope,
    prepare,
    status,
    state: raw.state as RatingCategoryIconUploadMember['state'],
    assetId,
  });
}
function obligationsFor(
  uploads: PendingRatingCategoryIconUploads,
): readonly CategoryIconUploadObligation[] {
  return Object.freeze(
    uploads.members.map((member) => {
      const scope = member.scope;
      return Object.freeze({
        memberId: member.memberId,
        slotKey: member.slotKey,
        clientRequestId: member.scopeInput.clientRequestId,
        scopeRequestHash: categoryIconScopeRequestHash(member.scopeInput),
        scope:
          scope === null
            ? null
            : Object.freeze({
                editScopeId: scope.editScopeId,
                scopeRevision: scope.scopeRevision,
                categoryId: scope.categoryId,
                identityId: scope.identityId,
              }),
        requestHash:
          member.prepare === null
            ? null
            : categoryIconPrepareHash(uploads.accountId, member.prepare),
        assetId: member.assetId,
        selected: member.state === 'ready',
      });
    }),
  );
}
function decodeObligations(
  raw: unknown,
): readonly CategoryIconUploadObligation[] {
  if (!Array.isArray(raw) || raw.length > 128) invalidRating();
  const values = raw.map((item: unknown) => {
    exact(item, [
      'memberId',
      'slotKey',
      'clientRequestId',
      'scopeRequestHash',
      'scope',
      'requestHash',
      'assetId',
      'selected',
    ]);
    let scope: CategoryIconUploadObligation['scope'] = null;
    if (item.scope !== null) {
      exact(item.scope, [
        'editScopeId',
        'scopeRevision',
        'categoryId',
        'identityId',
      ]);
      scope = Object.freeze({
        editScopeId: id(item.scope.editScopeId),
        scopeRevision: digest(item.scope.scopeRevision),
        categoryId: id(item.scope.categoryId),
        identityId: id(item.scope.identityId),
      });
    }
    const requestHash =
        item.requestHash === null ? null : digest(item.requestHash),
      assetId = item.assetId === null ? null : id(item.assetId);
    if (
      typeof item.selected !== 'boolean' ||
      (scope === null) !== (requestHash === null) ||
      (assetId !== null && scope === null) ||
      (item.selected && assetId === null)
    )
      invalidRating();
    const key = slotKey(item.slotKey),
      parts = key.split(':');
    if (parts[0] !== 'new') {
      id(parts[1]);
      if (parts[0] === 'override') id(parts[2]);
      if (scope && scope.categoryId !== parts[1]) invalidRating();
    }
    return Object.freeze({
      memberId: id(item.memberId),
      slotKey: key,
      clientRequestId: id(item.clientRequestId),
      scopeRequestHash: digest(item.scopeRequestHash),
      scope,
      requestHash,
      assetId,
      selected: item.selected,
    });
  });
  if (
    new Set(values.map((v) => v.memberId)).size !== values.length ||
    new Set(values.map((v) => v.clientRequestId)).size !== values.length ||
    new Set(values.filter((v) => v.selected).map((v) => v.slotKey)).size !==
      values.filter((v) => v.selected).length ||
    values.filter((v) => v.selected).length > 32
  )
    invalidRating();
  const scopes = values.flatMap((v) => (v.scope ? [v.scope.editScopeId] : [])),
    assets = values.flatMap((v) => (v.assetId ? [v.assetId] : []));
  if (
    new Set(scopes).size !== scopes.length ||
    new Set(assets).size !== assets.length
  )
    invalidRating();
  return Object.freeze(values);
}
export function decodePendingRatingCategoryIconUploads(
  raw: unknown,
  actor: string,
): PendingRatingCategoryIconUploads {
  exact(raw, [
    'version',
    'phase',
    'accountId',
    'identity',
    'identityHash',
    'members',
  ]);
  if (
    raw.version !== 13 ||
    raw.phase !== 'uploads' ||
    id(raw.accountId) !== id(actor) ||
    !Array.isArray(raw.members) ||
    raw.members.length > 128
  )
    invalidRating();
  const identity = decodeRatingCategoryIconUploadIdentity(raw.identity),
    identityHash = digest(raw.identityHash),
    members = raw.members.map((member: unknown) =>
      decodeRatingCategoryIconUploadMember(member, actor),
    );
  if (
    identityHash !== ratingCategoryIconUploadIdentityHash(actor, identity) ||
    new Set(members.map((m) => m.memberId)).size !== members.length ||
    new Set(members.map((m) => m.scopeInput.clientRequestId)).size !==
      members.length
  )
    invalidRating();
  const active = members.filter(
    (m) => m.state !== 'retired' && m.state !== 'retiring',
  );
  if (
    new Set(active.map((m) => m.slotKey)).size !== active.length ||
    active.length > 32
  )
    invalidRating();
  for (const member of members) {
    const input = member.scopeInput,
      text = decodeRatingCategoryScopedIntent({
        protocolVersion: 2,
        operation: input.operation,
        context: input.context,
        payload: input.payload,
      });
    if (
      !same(text, identity.textIntent) ||
      input.mediaSnapshot !== identity.mediaSnapshot ||
      input.draftRevision !== identity.draftRevision ||
      !identity.slots.some(
        (slot) => slot.key === member.slotKey && slot.selection === 'replace',
      )
    )
      invalidRating();
  }
  const value: PendingRatingCategoryIconUploads = Object.freeze({
    version: 13,
    phase: 'uploads',
    accountId: actor,
    identity,
    identityHash,
    members: Object.freeze(members),
  });
  decodeObligations(obligationsFor(value));
  return value;
}
function intentSlots(
  intent: RatingCategoryIconIntent,
): readonly CategoryIconDraftSlot[] {
  const layout = ratingCategoryIconSlotLayout(categoryIconTextIntent(intent));
  const selections: CategoryIconDraftSelection[] = [];
  switch (intent.operation) {
    case 'create_categories_scoped':
      selections.push(...intent.payload.nodes.map((node) => node.icon.mode));
      break;
    case 'batch_update_subcategories_scoped':
      selections.push(...intent.payload.addNodes.map((node) => node.icon.mode));
      break;
    case 'edit_category_base_scoped':
    case 'create_system_category_scoped':
      selections.push(intent.payload.icon.mode);
      break;
    case 'set_category_override_scoped': {
      const icon = intent.payload.icon;
      selections.push(
        icon.mode === 'inherit'
          ? 'inherit'
          : icon.value === null
            ? 'set-empty'
            : icon.value.mode,
      );
      break;
    }
  }
  return layout.map((slot, index) => ({
    ...slot,
    selection: selections[index]!,
  }));
}
function replacements(intent: RatingCategoryIconIntent): readonly {
  readonly slotKey: string;
  readonly assetId: string;
  readonly uploadScopeId: string;
}[] {
  const rows: { slotKey: string; assetId: string; uploadScopeId: string }[] =
    [];
  switch (intent.operation) {
    case 'create_categories_scoped':
      for (const node of intent.payload.nodes)
        if (node.icon.mode === 'replace')
          rows.push({ slotKey: `new:${node.key}`, ...node.icon });
      break;
    case 'batch_update_subcategories_scoped':
      for (const node of intent.payload.addNodes)
        if (node.icon.mode === 'replace')
          rows.push({ slotKey: `new:${node.key}`, ...node.icon });
      break;
    case 'create_system_category_scoped':
      if (intent.payload.icon.mode === 'replace')
        rows.push({ slotKey: 'new:root', ...intent.payload.icon });
      break;
    case 'edit_category_base_scoped':
      if (intent.payload.icon.mode === 'replace')
        rows.push({
          slotKey: `base:${intent.payload.categoryId}`,
          ...intent.payload.icon,
        });
      break;
    case 'set_category_override_scoped': {
      const icon = intent.payload.icon;
      if (icon.mode === 'set' && icon.value?.mode === 'replace') {
        if (intent.context.selector.kind !== 'campus') invalidRating();
        rows.push({
          slotKey: `override:${intent.payload.categoryId}:${intent.context.selector.campusId}`,
          ...icon.value,
        });
      }
      break;
    }
  }
  return rows;
}
function matchObligations(
  intent: RatingCategoryIconIntent,
  obligations: readonly CategoryIconUploadObligation[],
): void {
  const refs = replacements(intent),
    selected = obligations.filter((o) => o.selected);
  if (
    selected.length !== refs.length ||
    refs.some(
      (ref) =>
        !selected.some(
          (o) =>
            o.slotKey === ref.slotKey &&
            o.assetId === ref.assetId &&
            o.scope?.editScopeId === ref.uploadScopeId,
        ),
    )
  )
    invalidRating();
  for (const obligation of obligations)
    if (obligation.clientRequestId === intent.payload.clientRequestId)
      invalidRating();
}
export function decodePendingRatingCategoryIconCommand(
  raw: unknown,
  actor: string,
): PendingRatingCategoryIconCommand {
  exact(raw, [
    'version',
    'phase',
    'accountId',
    'intent',
    'identityHash',
    'obligations',
    'receipt',
  ]);
  if (
    raw.version !== 13 ||
    raw.phase !== 'command' ||
    id(raw.accountId) !== id(actor)
  )
    invalidRating();
  const intent = decodeRatingCategoryIconIntent(raw.intent),
    identityHash = raw.identityHash === null ? null : digest(raw.identityHash),
    obligations = decodeObligations(raw.obligations),
    receipt =
      raw.receipt === null
        ? null
        : decodeRatingCategoryIconReceipt(raw.receipt);
  if (obligations.length > 0 && identityHash === null) invalidRating();
  matchObligations(intent, obligations);
  if (receipt) matchRatingCategoryIconReceipt(intent, receipt);
  return Object.freeze({
    version: 13,
    phase: 'command',
    accountId: actor,
    intent,
    identityHash,
    obligations,
    receipt,
  });
}
function opaqueUploads(
  raw: unknown,
  actor: string,
): OpaqueRatingCategoryIconUploads {
  if (isRecord(raw) && raw.phase === 'uploads') {
    const uploads = decodePendingRatingCategoryIconUploads(raw, actor);
    if (!same(raw, uploads)) invalidRating();
    return Object.freeze({
      version: 13,
      phase: 'uploads-opaque',
      accountId: actor,
      commandRequestId: uploads.identity.textIntent.payload.clientRequestId,
      identityHash: uploads.identityHash,
      obligations: obligationsFor(uploads),
    });
  }
  exact(raw, [
    'version',
    'phase',
    'accountId',
    'commandRequestId',
    'identityHash',
    'obligations',
  ]);
  if (
    raw.version !== 13 ||
    raw.phase !== 'uploads-opaque' ||
    id(raw.accountId) !== id(actor)
  )
    invalidRating();
  const obligations = decodeObligations(raw.obligations),
    commandRequestId = id(raw.commandRequestId);
  if (obligations.some((o) => o.clientRequestId === commandRequestId))
    invalidRating();
  return Object.freeze({
    version: 13,
    phase: 'uploads-opaque',
    accountId: actor,
    commandRequestId,
    identityHash: digest(raw.identityHash),
    obligations,
  });
}
function matchOpaqueReceipt(
  command: OpaqueRatingCategoryIconCommand,
  raw: RatingCategoryIconReceipt,
): void {
  const receipt = decodeRatingCategoryIconReceipt(raw);
  if (
    receipt.requestId !== command.requestId ||
    receipt.operation !== command.operation ||
    receipt.intentHash !== command.intentHash
  )
    invalidRating();
}
function opaqueCommand(
  raw: unknown,
  actor: string,
): OpaqueRatingCategoryIconCommand {
  if (isRecord(raw) && raw.phase === 'command') {
    const command = decodePendingRatingCategoryIconCommand(raw, actor);
    if (!same(raw, command)) invalidRating();
    return Object.freeze({
      version: 13,
      phase: 'command-opaque',
      accountId: actor,
      requestId: command.intent.payload.clientRequestId,
      operation: command.intent.operation,
      intentHash: ratingCategoryIconIntentHash(command.intent),
      identityHash: command.identityHash,
      obligations: command.obligations,
      receipt: command.receipt,
    });
  }
  exact(raw, [
    'version',
    'phase',
    'accountId',
    'requestId',
    'operation',
    'intentHash',
    'identityHash',
    'obligations',
    'receipt',
  ]);
  if (
    raw.version !== 13 ||
    raw.phase !== 'command-opaque' ||
    id(raw.accountId) !== id(actor) ||
    !ratingCategoryScopedOperations.includes(
      raw.operation as RatingCategoryScopedOperation,
    )
  )
    invalidRating();
  const value: OpaqueRatingCategoryIconCommand = Object.freeze({
    version: 13,
    phase: 'command-opaque',
    accountId: actor,
    requestId: id(raw.requestId),
    operation: raw.operation as RatingCategoryScopedOperation,
    intentHash: digest(raw.intentHash),
    identityHash: raw.identityHash === null ? null : digest(raw.identityHash),
    obligations: decodeObligations(raw.obligations),
    receipt:
      raw.receipt === null
        ? null
        : decodeRatingCategoryIconReceipt(raw.receipt),
  });
  if (
    (value.obligations.length > 0 && value.identityHash === null) ||
    value.obligations.some((o) => o.clientRequestId === value.requestId)
  )
    invalidRating();
  if (value.receipt) matchOpaqueReceipt(value, value.receipt);
  return value;
}
function matchPair(
  uploads: OpaqueRatingCategoryIconUploads | null,
  command: OpaqueRatingCategoryIconCommand | null,
): void {
  if (
    uploads &&
    command &&
    (uploads.commandRequestId !== command.requestId ||
      uploads.identityHash !== command.identityHash ||
      !same(uploads.obligations, command.obligations))
  )
    throw unavailable();
  if (command?.identityHash && !uploads && !command.receipt)
    throw unavailable();
}
function checkSettlements(
  obligations: readonly CategoryIconUploadObligation[],
  raw: readonly CategoryIconUploadSettlement[],
  receipt: RatingCategoryIconReceipt | null,
): void {
  if (!Array.isArray(raw) || raw.length !== obligations.length)
    throw unavailable();
  const proofs = raw.map((proof: unknown) => {
    exact(proof, ['clientRequestId', 'scopeRequestHash', 'response']);
    return {
      clientRequestId: id(proof.clientRequestId),
      scopeRequestHash: digest(proof.scopeRequestHash),
      response: decodeCategoryIconScopeRecovery(proof.response),
    };
  });
  if (new Set(proofs.map((p) => p.clientRequestId)).size !== proofs.length)
    throw unavailable();
  for (const obligation of obligations) {
    const proof = proofs.find(
      (p) => p.clientRequestId === obligation.clientRequestId,
    );
    if (
      !proof ||
      proof.scopeRequestHash !== obligation.scopeRequestHash ||
      proof.response.state === 'unknown'
    )
      throw unavailable();
    const response = proof.response,
      scope = response.scope,
      recovery = response.recovery;
    if (
      obligation.scope &&
      (!scope ||
        scope.editScopeId !== obligation.scope.editScopeId ||
        scope.scopeRevision !== obligation.scope.scopeRevision ||
        scope.categoryId !== obligation.scope.categoryId ||
        scope.identityId !== obligation.scope.identityId)
    )
      throw unavailable();
    if (
      recovery &&
      (recovery.requestId !== obligation.clientRequestId ||
        (obligation.requestHash !== null &&
          recovery.state !== 'not_recorded' &&
          recovery.requestHash !== obligation.requestHash))
    )
      throw unavailable();
    if (
      obligation.selected &&
      receipt !== null &&
      receipt.outcome !== 'closed'
    ) {
      if (
        response.state !== 'known' ||
        !scope ||
        !obligation.scope ||
        recovery?.state !== 'recorded' ||
        recovery.status.status !== 'bound_history' ||
        recovery.status.assetId !== obligation.assetId ||
        recovery.status.categoryId !== obligation.scope.categoryId ||
        recovery.status.editScopeId !== obligation.scope.editScopeId ||
        !receipt.result.categoryIds.includes(recovery.status.categoryId)
      )
        throw unavailable();
      continue;
    }
    // An explicit owner cancellation fence also closes a request whose original
    // scope response was lost before Media prepare. Mere absence never does.
    if (
      response.state === 'cancelled' &&
      scope === null &&
      recovery === null &&
      obligation.scope === null
    )
      continue;
    if (!scope || !recovery || recovery.state === 'not_recorded')
      throw unavailable();
    if (recovery.state === 'cancelled_before_prepare') continue;
    if (
      recovery.status.editScopeId !== scope.editScopeId ||
      recovery.status.status !== 'terminal' ||
      recovery.status.cleanup !== 'confirmed'
    )
      throw unavailable();
  }
}

/** Independent actor-local v13 ledger. Historical values are checked only for
 * new writes; neither this decoder nor any v1-v12 decoder reinterprets another
 * protocol. Both keys intentionally remain blocking on corruption. */
export class PendingRatingCategoryIconStore {
  private readonly scrubRequired = new Set<string>();
  private readonly hydratedActors = new Set<string>();
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  watchSession(sessions: SessionStore): () => void {
    let owner = sessions.snapshot();
    return sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        current.epoch !== owner.epoch ||
        current.credentials?.accountId !== owner.credentials?.accountId
      ) {
        const actor = owner.credentials?.accountId;
        if (actor) {
          this.scrubRequired.add(actor);
          try {
            this.minimize(actor);
          } catch {
            /* Unknown publication remains blocking. */
          }
        }
        owner = current;
      }
    });
  }
  private key(actor: string, phase: 'uploads' | 'command'): string {
    return `whaleu.ratings.pending.v13.${phase}:${this.origin}:${id(actor)}`;
  }
  private absent(raw: unknown): boolean {
    return raw === null || raw === undefined || raw === '';
  }
  private hydrate(actor: string): void {
    if (this.hydratedActors.has(actor)) return;
    const uploads = this.storage.get(this.key(actor, 'uploads')),
      command = this.storage.get(this.key(actor, 'command'));
    if (!this.absent(uploads) || !this.absent(command))
      this.scrubRequired.add(actor);
    this.hydratedActors.add(actor);
  }
  assertLegacyClear(actor: string): void {
    try {
      for (let version = 1; version <= 11; version++)
        if (
          !this.absent(
            this.storage.get(
              `whaleu.ratings.pending.v${version}:${this.origin}:${id(actor)}`,
            ),
          )
        )
          throw unavailable();
      for (const phase of ['batch', 'command'])
        if (
          !this.absent(
            this.storage.get(
              `whaleu.ratings.pending.v12.${phase}:${this.origin}:${id(actor)}`,
            ),
          )
        )
          throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  isOpaque(actor: string): boolean {
    try {
      this.hydrate(actor);
      const uploads = this.storage.get(this.key(actor, 'uploads')),
        command = this.storage.get(this.key(actor, 'command'));
      return (
        (this.scrubRequired.has(actor) &&
          (!this.absent(uploads) || !this.absent(command))) ||
        (isRecord(uploads) && uploads.phase === 'uploads-opaque') ||
        (isRecord(command) && command.phase === 'command-opaque')
      );
    } catch {
      throw unavailable();
    }
  }
  opaqueRecovery(actor: string): OpaqueRatingCategoryIconRecovery {
    try {
      this.hydrate(actor);
      const u = this.storage.get(this.key(actor, 'uploads')),
        c = this.storage.get(this.key(actor, 'command')),
        uploads = this.absent(u) ? null : opaqueUploads(u, actor),
        command = this.absent(c) ? null : opaqueCommand(c, actor);
      matchPair(uploads, command);
      return Object.freeze({ uploads, command });
    } catch {
      throw unavailable();
    }
  }
  minimize(actor: string): void {
    // Revoke in-memory publication before either scrub write can fail.
    this.scrubRequired.add(actor);
    const before = this.opaqueRecovery(actor);
    let failed = false;
    try {
      if (before.command) {
        this.storage.set(this.key(actor, 'command'), before.command);
        if (!same(this.storage.get(this.key(actor, 'command')), before.command))
          failed = true;
      }
    } catch {
      failed = true;
    }
    try {
      if (before.uploads) {
        this.storage.set(this.key(actor, 'uploads'), before.uploads);
        if (!same(this.storage.get(this.key(actor, 'uploads')), before.uploads))
          failed = true;
      }
    } catch {
      failed = true;
    }
    try {
      if (failed || !same(this.opaqueRecovery(actor), before))
        throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  load(actor: string): {
    readonly uploads: PendingRatingCategoryIconUploads | null;
    readonly command: PendingRatingCategoryIconCommand | null;
  } {
    try {
      this.hydrate(actor);
      const u = this.storage.get(this.key(actor, 'uploads')),
        c = this.storage.get(this.key(actor, 'command'));
      if (this.scrubRequired.has(actor) && (!this.absent(u) || !this.absent(c)))
        throw unavailable();
      const uploads = this.absent(u)
          ? null
          : decodePendingRatingCategoryIconUploads(u, actor),
        command = this.absent(c)
          ? null
          : decodePendingRatingCategoryIconCommand(c, actor);
      if ((uploads && !same(uploads, u)) || (command && !same(command, c)))
        throw unavailable();
      if (uploads && command) this.match(uploads, command.intent);
      matchPair(
        uploads ? opaqueUploads(uploads, actor) : null,
        command ? opaqueCommand(command, actor) : null,
      );
      return Object.freeze({ uploads, command });
    } catch {
      throw unavailable();
    }
  }
  start(
    raw: PendingRatingCategoryIconUploads,
  ): PendingRatingCategoryIconUploads {
    const value = decodePendingRatingCategoryIconUploads(raw, raw.accountId);
    this.assertLegacyClear(value.accountId);
    const old = this.load(value.accountId);
    if (old.uploads || old.command || value.members.length !== 0)
      throw unavailable();
    this.scrubRequired.delete(value.accountId);
    this.storage.set(this.key(value.accountId, 'uploads'), value);
    if (!same(this.load(value.accountId).uploads, value)) throw unavailable();
    return value;
  }
  update(
    before: PendingRatingCategoryIconUploads,
    raw: PendingRatingCategoryIconUploads,
  ): PendingRatingCategoryIconUploads {
    const old = this.load(before.accountId),
      value = decodePendingRatingCategoryIconUploads(raw, before.accountId);
    if (
      !same(old.uploads, before) ||
      old.command ||
      value.identityHash !== before.identityHash ||
      !same(value.identity, before.identity)
    )
      throw unavailable();
    for (const member of before.members) {
      const next = value.members.find((m) => m.memberId === member.memberId);
      if (
        !next ||
        next.slotKey !== member.slotKey ||
        !same(next.scopeInput, member.scopeInput) ||
        (member.scope !== null && !same(member.scope, next.scope)) ||
        (member.prepare !== null && !same(member.prepare, next.prepare)) ||
        (member.assetId !== null && next.assetId !== member.assetId) ||
        (member.status !== null && next.status === null) ||
        (member.status !== null &&
          next.status !== null &&
          member.status.intentId !== next.status.intentId) ||
        (member.state === 'ready' &&
          !['ready', 'retiring', 'retired'].includes(next.state)) ||
        (member.state === 'retiring' &&
          !['retiring', 'retired'].includes(next.state)) ||
        (member.state === 'retired' && !same(member, next))
      )
        throw unavailable();
    }
    for (const member of value.members)
      if (
        !before.members.some((m) => m.memberId === member.memberId) &&
        (member.state !== 'pending' ||
          member.scope !== null ||
          member.prepare !== null ||
          member.status !== null ||
          member.assetId !== null)
      )
        throw unavailable();
    this.storage.set(this.key(before.accountId, 'uploads'), value);
    if (!same(this.load(before.accountId).uploads, value)) throw unavailable();
    return value;
  }
  private match(
    uploads: PendingRatingCategoryIconUploads,
    intent: RatingCategoryIconIntent,
  ): void {
    if (
      !same(uploads.identity.textIntent, categoryIconTextIntent(intent)) ||
      uploads.identity.mediaSnapshot !== intent.mediaSnapshot ||
      !same(uploads.identity.slots, intentSlots(intent)) ||
      uploads.members.some((m) => m.state !== 'ready' && m.state !== 'retired')
    )
      throw unavailable();
    matchObligations(intent, obligationsFor(uploads));
  }
  freezeCommand(
    actor: string,
    raw: RatingCategoryIconIntent,
  ): PendingRatingCategoryIconCommand {
    const intent = decodeRatingCategoryIconIntent(raw),
      old = this.load(actor);
    if (old.command) {
      if (!same(old.command.intent, intent)) throw unavailable();
      return old.command;
    }
    this.assertLegacyClear(actor);
    if (old.uploads) this.match(old.uploads, intent);
    else if (replacements(intent).length > 0) throw unavailable();
    const value = decodePendingRatingCategoryIconCommand(
      {
        version: 13,
        phase: 'command',
        accountId: actor,
        intent,
        identityHash: old.uploads?.identityHash ?? null,
        obligations: old.uploads ? obligationsFor(old.uploads) : [],
        receipt: null,
      },
      actor,
    );
    this.scrubRequired.delete(actor);
    this.storage.set(this.key(actor, 'command'), value);
    if (!same(this.load(actor).command, value)) throw unavailable();
    return value;
  }
  recordReceipt(
    before: PendingRatingCategoryIconCommand,
    raw: RatingCategoryIconReceipt,
  ): PendingRatingCategoryIconCommand {
    if (!same(this.load(before.accountId).command, before)) throw unavailable();
    const receipt = decodeRatingCategoryIconReceipt(raw);
    matchRatingCategoryIconReceipt(before.intent, receipt);
    if (before.receipt && !same(before.receipt, receipt)) throw unavailable();
    const value = decodePendingRatingCategoryIconCommand(
      { ...before, receipt },
      before.accountId,
    );
    this.storage.set(this.key(before.accountId, 'command'), value);
    if (!same(this.load(before.accountId).command, value)) throw unavailable();
    return value;
  }
  recordOpaqueReceipt(
    before: OpaqueRatingCategoryIconCommand,
    raw: RatingCategoryIconReceipt,
  ): OpaqueRatingCategoryIconCommand {
    if (!same(this.opaqueRecovery(before.accountId).command, before))
      throw unavailable();
    const receipt = decodeRatingCategoryIconReceipt(raw);
    matchOpaqueReceipt(before, receipt);
    if (before.receipt && !same(before.receipt, receipt)) throw unavailable();
    const value = opaqueCommand({ ...before, receipt }, before.accountId);
    this.storage.set(this.key(before.accountId, 'command'), value);
    if (
      !same(this.storage.get(this.key(before.accountId, 'command')), value) ||
      !same(this.opaqueRecovery(before.accountId).command, value)
    )
      throw unavailable();
    return value;
  }
  private clear(
    actor: string,
    command: OpaqueRatingCategoryIconCommand | null,
  ): void {
    // Persisted receipt and all Media/native completion proofs precede deletion.
    // A crash at either boundary leaves enough in the remaining command key.
    this.storage.remove(this.key(actor, 'uploads'));
    if (!this.absent(this.storage.get(this.key(actor, 'uploads'))))
      throw unavailable();
    if (command && !same(this.opaqueRecovery(actor).command, command))
      throw unavailable();
    this.storage.remove(this.key(actor, 'command'));
    if (!this.absent(this.storage.get(this.key(actor, 'command'))))
      throw unavailable();
    this.scrubRequired.delete(actor);
  }
  settleCommand(
    before: PendingRatingCategoryIconCommand,
    proofs: readonly CategoryIconUploadSettlement[],
    nativeComplete: boolean,
  ): void {
    const current = this.load(before.accountId);
    if (!nativeComplete || !same(current.command, before) || !before.receipt)
      throw unavailable();
    matchRatingCategoryIconReceipt(before.intent, before.receipt);
    checkSettlements(before.obligations, proofs, before.receipt);
    this.clear(before.accountId, opaqueCommand(before, before.accountId));
  }
  settleUploadsCancellation(
    before: PendingRatingCategoryIconUploads,
    proofs: readonly CategoryIconUploadSettlement[],
    nativeComplete: boolean,
  ): void {
    const current = this.load(before.accountId);
    if (!nativeComplete || current.command || !same(current.uploads, before))
      throw unavailable();
    checkSettlements(obligationsFor(before), proofs, null);
    this.clear(before.accountId, null);
  }
  clearUploads(
    before: PendingRatingCategoryIconUploads,
    proofs: readonly CategoryIconUploadSettlement[],
    nativeComplete: boolean,
  ): void {
    this.settleUploadsCancellation(before, proofs, nativeComplete);
  }
  settleOpaque(
    before: OpaqueRatingCategoryIconRecovery,
    proofs: readonly CategoryIconUploadSettlement[],
    nativeComplete: boolean,
  ): void {
    const actor = before.command?.accountId ?? before.uploads?.accountId;
    if (
      !actor ||
      !nativeComplete ||
      !same(this.opaqueRecovery(actor), before) ||
      (before.command && !before.command.receipt)
    )
      throw unavailable();
    checkSettlements(
      before.command?.obligations ?? before.uploads?.obligations ?? [],
      proofs,
      before.command?.receipt ?? null,
    );
    this.clear(actor, before.command);
  }
}
