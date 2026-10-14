/** Same-origin operational replacement for the legacy ratingPush URL.
 * The supported host owns authentication. This module never accepts a bearer token.
 * Keep the two browser factories self-contained: the server serves their emitted JS.
 */
export const RATING_GROUP_PROMOTION_OPERATOR_PATH =
  '/operator/rating-group-promotion';
export const RATING_GROUP_PROMOTION_OPERATOR_SCRIPT_PATH = `${RATING_GROUP_PROMOTION_OPERATOR_PATH}/controller.js`;
export const RATING_GROUP_PROMOTION_OPERATOR_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, private, max-age=0',
  Pragma: 'no-cache',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

export interface RatingPromotionOperatorIdentity {
  actorId: string;
  origin: string;
}
export interface RatingPromotionOperatorBridge {
  readonly version: 'rating-group-promotion-v1';
  readonly origin: string;
  getIdentity(): Promise<RatingPromotionOperatorIdentity | null>;
  /** The host sends its current bearer credentials; never return them to the shell. */
  request(
    path: string,
    init: {
      method: 'GET' | 'POST';
      body?: string;
      signal: AbortSignal;
      cache: 'no-store';
      credentials: 'same-origin';
    },
  ): Promise<Response>;
  /** Notify synchronously on sign-out, account changes, or session revocation. */
  subscribe(invalidate: () => void): () => void;
}
export interface RatingPromotionOperatorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface RatingPromotionOperatorJournal {
  origin: string;
  actorId: string;
  programId: string;
  requestId: string;
  ticketExpiresAt: string;
  requestHash: string;
}
export interface RatingPromotionOperatorAudience {
  school: number;
  default: number;
  test: number;
  total: number;
}
export interface RatingPromotionOperatorProgram {
  programId: string;
  revision: string;
  type: 'course' | 'canteen';
  audience: RatingPromotionOperatorAudience;
  copyModes: ('deterministic' | 'assisted')[];
  linkModes: ('native' | 'shortlink_optional' | 'shortlink_required')[];
}
export interface RatingPromotionOperatorDestination {
  id: string;
  label: string;
}
export interface RatingPromotionOperatorPreview {
  previewId: string;
  type: 'course' | 'canteen';
  mode: 'normal' | 'test';
  expectedProgramRevision: string;
  expiresAt: string;
  copy: string;
  locator: string;
  audience: RatingPromotionOperatorAudience;
  testDestination?: RatingPromotionOperatorDestination;
}
export interface RatingPromotionOperatorCounts {
  confirmed: number;
  unknown: number;
  notSent: number;
  pending: number;
}
export interface RatingPromotionOperatorMetadata {
  requestId: string;
  requestHash: string;
  campaignId?: string;
  admission: string;
  composition: string;
  delivery: string;
  cancelRequested: boolean;
  payloadExpired: boolean;
  counts: RatingPromotionOperatorCounts;
  stages: {
    generation: RatingPromotionOperatorCounts;
    shortlink: RatingPromotionOperatorCounts;
    delivery: RatingPromotionOperatorCounts;
  } | null;
  remoteMessageMayRemain: boolean;
}
export interface RatingPromotionOperatorState {
  phase:
    | 'blocked'
    | 'loading'
    | 'ready'
    | 'preview'
    | 'sending'
    | 'recovering'
    | 'recorded'
    | 'sealed'
    | 'error'
    | 'hidden';
  programId: string;
  program: RatingPromotionOperatorProgram | null;
  preview: RatingPromotionOperatorPreview | null;
  destinations: RatingPromotionOperatorDestination[];
  nextDestinationCursor: string | null;
  confirmation: string | null;
  metadata: RatingPromotionOperatorMetadata | null;
  payload: { copy: string; locator: string } | null;
  actions: string[];
  hasPendingRequest: boolean;
  error: string | null;
}
export interface RatingPromotionOperatorDependencies {
  origin: string;
  programId: string;
  bridge: RatingPromotionOperatorBridge | null;
  storage: RatingPromotionOperatorStorage;
  getOrigin?: () => string;
  onChange?: (state: RatingPromotionOperatorState) => void;
  now?: () => number;
  randomUUID?: () => string;
}
export interface RatingPromotionOperatorController {
  getState(): RatingPromotionOperatorState;
  connect(): Promise<void>;
  preview(mode: 'normal' | 'test', testDestinationId?: string): Promise<void>;
  confirm(input: {
    previewId: string;
    confirmation: string;
    copyMode: 'deterministic' | 'assisted';
    linkMode: 'native' | 'shortlink_optional' | 'shortlink_required';
  }): Promise<void>;
  recover(): Promise<void>;
  sealOriginal(): Promise<void>;
  inspectPayload(): Promise<void>;
  clearPreview(): void;
  moreDestinations(): Promise<void>;
  suspend(): void;
  navigate(programId: string): Promise<void>;
  dispose(): void;
}

export function createRatingGroupPromotionOperator(
  deps: RatingPromotionOperatorDependencies,
): RatingPromotionOperatorController {
  const id =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const hash = /^[a-f0-9]{64}$/;
  const now = deps.now ?? Date.now;
  const origin = deps.origin;
  const bridge = deps.bridge;
  const stale = new Error('STALE_VIEW');
  let epoch = 0;
  let busy = false;
  let disposed = false;
  let actor: RatingPromotionOperatorIdentity | null = null;
  let journal: RatingPromotionOperatorJournal | null = null;
  let abort = new AbortController();
  let unsubscribe = () => {};
  let state: RatingPromotionOperatorState = empty(deps.programId, 'blocked');
  function empty(
    programId: string,
    phase: RatingPromotionOperatorState['phase'],
  ): RatingPromotionOperatorState {
    return {
      phase,
      programId,
      program: null,
      preview: null,
      destinations: [],
      nextDestinationCursor: null,
      confirmation: null,
      metadata: null,
      payload: null,
      actions: [],
      hasPendingRequest: false,
      error: null,
    };
  }
  function emit() {
    deps.onChange?.(structuredClone(state));
  }
  function fail(code: string): never {
    throw new Error(code);
  }
  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return fail('PROMOTION_INVALID_RESPONSE');
    return value as Record<string, unknown>;
  }
  function string(value: unknown, max = 512): string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > max ||
      /\p{Cc}/u.test(value)
    )
      return fail('PROMOTION_INVALID_RESPONSE');
    return value;
  }
  function uuid(value: unknown): string {
    const result = string(value, 36);
    if (!id.test(result)) return fail('PROMOTION_INVALID_RESPONSE');
    return result;
  }
  function digest(value: unknown): string {
    const result = string(value, 64);
    if (!hash.test(result)) return fail('PROMOTION_INVALID_RESPONSE');
    return result;
  }
  function date(value: unknown): string {
    const result = string(value, 40);
    if (!Number.isFinite(Date.parse(result)))
      return fail('PROMOTION_INVALID_RESPONSE');
    return result;
  }
  function number(value: unknown): number {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 10000
    )
      return fail('PROMOTION_INVALID_RESPONSE');
    return value;
  }
  function audience(value: unknown): RatingPromotionOperatorAudience {
    const row = record(value);
    const result = {
      school: number(row['school']),
      default: number(row['default']),
      test: number(row['test']),
      total: number(row['total']),
    };
    if (result.total !== result.school + result.default + result.test)
      return fail('PROMOTION_INVALID_RESPONSE');
    return result;
  }
  function destination(value: unknown): RatingPromotionOperatorDestination {
    const row = record(value);
    return { id: uuid(row['id']), label: string(row['label'], 120) };
  }
  function locator(value: unknown, allowSynthetic = false): string {
    const result = string(value, 200);
    if (
      allowSynthetic &&
      /^synthetic:\/\/rating-promotion\/[a-zA-Z0-9_-]+$/.test(result)
    )
      return result;
    const match =
      /^pages\/rating-catalog\/rating-catalog\?parentId=([^&]+)(?:&regionId=([^&]+))?$/.exec(
        result,
      );
    if (
      !match ||
      !id.test(match[1] ?? '') ||
      (match[2] !== undefined && !id.test(match[2]))
    )
      return fail('PROMOTION_INVALID_RESPONSE');
    return result;
  }
  function payload(
    value: unknown,
    allowSynthetic = false,
  ): { copy: string; locator: string } {
    const row = record(value);
    const copy = string(row['copy'], 112);
    if (
      [...copy].length > 28 ||
      copy !== copy.normalize('NFC') ||
      /[\p{Cc}\p{Cs}\p{Cf}<>@{}[\]`]|https?:|www\.|:\/\//iu.test(copy)
    )
      return fail('PROMOTION_INVALID_RESPONSE');
    return { copy, locator: locator(row['locator'], allowSynthetic) };
  }
  function safeState(value: unknown): string {
    const result = string(value, 64);
    if (!/^[a-z][a-z_]*$/.test(result))
      return fail('PROMOTION_INVALID_RESPONSE');
    return result;
  }
  function metadata(
    value: unknown,
    original: RatingPromotionOperatorJournal,
  ): RatingPromotionOperatorMetadata {
    const row = record(value);
    const counts = record(row['counts']);
    const stageCounts = (value: unknown): RatingPromotionOperatorCounts => {
      const stage = record(value);
      return {
        confirmed: number(stage['confirmed']),
        unknown: number(stage['unknown']),
        notSent: number(stage['notSent']),
        pending: number(stage['pending']),
      };
    };
    const stages = row['stages'] === undefined ? null : record(row['stages']);
    if (
      uuid(row['requestId']) !== original.requestId ||
      digest(row['requestHash']) !== original.requestHash
    )
      return fail('PROMOTION_REQUEST_CONFLICT');
    return {
      requestId: original.requestId,
      requestHash: original.requestHash,
      ...(row['campaignId'] === undefined || row['campaignId'] === null
        ? {}
        : { campaignId: uuid(row['campaignId']) }),
      admission: safeState(row['admission']),
      composition: safeState(row['composition']),
      delivery: safeState(row['delivery']),
      cancelRequested: row['cancelRequested'] === true,
      payloadExpired: row['payloadExpired'] === true,
      counts: {
        confirmed: number(counts['confirmed']),
        unknown: number(counts['unknown']),
        notSent: number(counts['notSent']),
        pending: number(counts['pending']),
      },
      stages:
        stages === null
          ? null
          : {
              generation: stageCounts(stages['generation']),
              shortlink: stageCounts(stages['shortlink']),
              delivery: stageCounts(stages['delivery']),
            },
      remoteMessageMayRemain:
        row['remoteMessageMayRemain'] === true ||
        number(counts['confirmed']) > 0 ||
        number(counts['unknown']) > 0,
    };
  }
  function check(lease: number) {
    if (
      disposed ||
      lease !== epoch ||
      !actor ||
      actor.origin !== origin ||
      (deps.getOrigin?.() ?? origin) !== origin ||
      bridge?.origin !== origin
    )
      throw stale;
  }
  function key() {
    if (!actor) return fail('PROMOTION_AUTH_REQUIRED');
    return `rating-group-promotion:v1:${encodeURIComponent(origin)}:${actor.actorId}:${state.programId}`;
  }
  function readJournal(): RatingPromotionOperatorJournal | null {
    let raw: string | null;
    try {
      raw = deps.storage.getItem(key());
    } catch {
      return fail('PROMOTION_JOURNAL_UNAVAILABLE');
    }
    if (raw === null) return null;
    try {
      if (raw.length > 1024) return fail('PROMOTION_JOURNAL_INVALID');
      const row = record(JSON.parse(raw));
      if (
        Object.keys(row).sort().join(',') !==
        'actorId,origin,programId,requestHash,requestId,ticketExpiresAt'
      )
        return fail('PROMOTION_JOURNAL_INVALID');
      if (
        row['origin'] !== origin ||
        row['actorId'] !== actor?.actorId ||
        row['programId'] !== state.programId
      )
        return fail('PROMOTION_JOURNAL_INVALID');
      return {
        origin,
        actorId: uuid(row['actorId']),
        programId: uuid(row['programId']),
        requestId: uuid(row['requestId']),
        ticketExpiresAt: date(row['ticketExpiresAt']),
        requestHash: digest(row['requestHash']),
      };
    } catch {
      return fail('PROMOTION_JOURNAL_INVALID');
    }
  }
  function readback(original: RatingPromotionOperatorJournal) {
    const stored = readJournal();
    if (!stored || JSON.stringify(stored) !== JSON.stringify(original))
      return fail('PROMOTION_JOURNAL_UNAVAILABLE');
  }
  function persist(original: RatingPromotionOperatorJournal, lease: number) {
    check(lease);
    const existing = readJournal();
    if (existing && JSON.stringify(existing) !== JSON.stringify(original))
      return fail('PROMOTION_REQUEST_PENDING');
    try {
      deps.storage.setItem(key(), JSON.stringify(original));
    } catch {
      return fail('PROMOTION_JOURNAL_UNAVAILABLE');
    }
    readback(original);
    journal = original;
    state.hasPendingRequest = true;
  }
  async function request(
    path: string,
    method: 'GET' | 'POST',
    lease: number,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    check(lease);
    if (
      !bridge ||
      !path.startsWith('/v1/rating-group-promotion/') ||
      path.startsWith('//')
    )
      return fail('PROMOTION_UNSUPPORTED_BRIDGE');
    const response = await bridge.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: abort.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    check(lease);
    const raw = await response.text();
    check(lease);
    if (raw.length > 32768) return fail('PROMOTION_INVALID_RESPONSE');
    let result: Record<string, unknown>;
    try {
      result = record(JSON.parse(raw));
    } catch {
      return fail('PROMOTION_INVALID_RESPONSE');
    }
    if (!response.ok) {
      const error =
        typeof result['error'] === 'object' && result['error'] !== null
          ? record(result['error'])
          : result;
      const code = error['code'];
      if (
        typeof code === 'string' &&
        /^PROMOTION_[A-Z_]+$/.test(code) &&
        code.length < 80
      )
        return fail(code);
      return fail(
        response.status === 401
          ? 'PROMOTION_AUTH_REQUIRED'
          : response.status === 403
            ? 'PROMOTION_FORBIDDEN'
            : 'PROMOTION_UNAVAILABLE',
      );
    }
    return result;
  }
  function base() {
    return `/v1/rating-group-promotion/programs/${uuid(state.programId)}`;
  }
  function showError(error: unknown, lease: number) {
    if (disposed || lease !== epoch || error === stale) return;
    state.preview = null;
    state.payload = null;
    state.confirmation = null;
    state.program = null;
    state.destinations = [];
    state.nextDestinationCursor = null;
    state.actions = [];
    state.metadata = null;
    state.error =
      error instanceof Error && /^PROMOTION_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'PROMOTION_UNAVAILABLE';
    state.phase = 'error';
    emit();
  }
  async function action(work: (lease: number) => Promise<void>) {
    if (busy || disposed) return;
    busy = true;
    const lease = epoch;
    try {
      check(lease);
      await work(lease);
    } catch (error) {
      showError(error, lease);
    } finally {
      if (lease === epoch) {
        busy = false;
        emit();
      }
    }
  }
  async function destinations(lease: number, cursor: string | null) {
    const result = await request(
      `${base()}/destinations?kind=test${cursor ? `&cursor=${uuid(cursor)}` : ''}`,
      'GET',
      lease,
    );
    if (!Array.isArray(result['items']) || result['items'].length > 100)
      return fail('PROMOTION_INVALID_RESPONSE');
    const items = result['items'].map(destination);
    const next =
      result['nextCursor'] === null || result['nextCursor'] === undefined
        ? null
        : uuid(result['nextCursor']);
    if (cursor !== null && next === cursor)
      return fail('PROMOTION_INVALID_RESPONSE');
    const all = cursor ? [...state.destinations, ...items] : items;
    if (
      all.length > 10000 ||
      new Set(all.map((item) => item.id)).size !== all.length
    )
      return fail('PROMOTION_INVALID_RESPONSE');
    state.destinations = all;
    state.nextDestinationCursor = next;
  }
  async function loadProgram(lease: number) {
    const capability = await request(
      `/v1/rating-group-promotion/capabilities?programId=${uuid(state.programId)}`,
      'GET',
      lease,
    );
    if (
      capability['enabled'] !== true ||
      capability['mode'] !== 'synthetic-only' ||
      !Array.isArray(capability['actions'])
    )
      return fail('PROMOTION_UNAVAILABLE');
    state.actions = capability['actions'].filter(
      (value): value is string =>
        typeof value === 'string' &&
        ['preview', 'send', 'test', 'inspect', 'cancel'].includes(value),
    );
    const row = await request(base(), 'GET', lease);
    if (
      uuid(row['programId']) !== state.programId ||
      (row['type'] !== 'course' && row['type'] !== 'canteen')
    )
      return fail('PROMOTION_INVALID_RESPONSE');
    const copyModes = row['copyModes'];
    const linkModes = row['linkModes'];
    if (
      !Array.isArray(copyModes) ||
      copyModes.length === 0 ||
      !copyModes.every((v) => v === 'deterministic' || v === 'assisted') ||
      !Array.isArray(linkModes) ||
      linkModes.length === 0 ||
      !linkModes.every((v) =>
        ['native', 'shortlink_optional', 'shortlink_required'].includes(v),
      )
    )
      return fail('PROMOTION_INVALID_RESPONSE');
    state.program = {
      programId: state.programId,
      revision: uuid(row['revision']),
      type: row['type'],
      audience: audience(row['audience']),
      copyModes,
      linkModes,
    };
    if (state.actions.includes('test')) await destinations(lease, null);
    state.phase = 'ready';
    state.error = null;
  }
  function acceptMetadata(
    value: unknown,
    original: RatingPromotionOperatorJournal,
  ) {
    state.metadata = metadata(value, original);
    state.preview = null;
    state.confirmation = null;
    state.payload = null;
    state.phase = state.metadata.admission === 'sealed' ? 'sealed' : 'recorded';
    state.error = null;
  }
  function parseIntent(row: Record<string, unknown>) {
    return {
      requestId: uuid(row['requestId']),
      requestHash: digest(row['requestHash']),
      intentTicket: string(row['intentTicket'], 1024),
      expiresAt: date(row['expiresAt']),
    };
  }
  async function recoverOriginal(lease: number) {
    const original = journal ?? readJournal();
    if (!original) return fail('PROMOTION_NO_PENDING_REQUEST');
    journal = original;
    state.hasPendingRequest = true;
    state.phase = 'recovering';
    state.payload = null;
    state.preview = null;
    state.confirmation = null;
    emit();
    const lookup = await request(
      `${base()}/requests/${original.requestId}`,
      'GET',
      lease,
    );
    if (lookup['recorded'] === true) {
      acceptMetadata(lookup['status'], original);
      return;
    }
    if (lookup['recorded'] !== false) return fail('PROMOTION_INVALID_RESPONSE');
    // Absence is not evidence that an old POST cannot arrive. Never allocate a new key.
    const recovered = await request(
      `${base()}/intents/${original.requestId}`,
      'GET',
      lease,
    );
    if (recovered['recorded'] === true) {
      acceptMetadata(recovered['status'], original);
      return;
    }
    const intent = parseIntent(recovered);
    if (
      intent.requestId !== original.requestId ||
      intent.requestHash !== original.requestHash ||
      intent.expiresAt !== original.ticketExpiresAt
    )
      return fail('PROMOTION_REQUEST_CONFLICT');
    if (Date.parse(intent.expiresAt) <= now())
      return fail('PROMOTION_INTENT_EXPIRED');
    readback(original);
    check(lease);
    const result = await request(`${base()}/campaigns`, 'POST', lease, {
      requestId: intent.requestId,
      intentTicket: intent.intentTicket,
      requestHash: intent.requestHash,
    });
    acceptMetadata(result, original);
  }
  function suspend() {
    epoch += 1;
    abort.abort();
    abort = new AbortController();
    busy = false;
    actor = null;
    journal = null;
    state = empty(state.programId, 'hidden');
    emit();
  }
  async function connect() {
    if (disposed) return;
    suspend();
    const lease = epoch;
    state.phase = 'loading';
    emit();
    busy = true;
    try {
      if (
        !bridge ||
        bridge.version !== 'rating-group-promotion-v1' ||
        bridge.origin !== origin ||
        typeof bridge.getIdentity !== 'function' ||
        typeof bridge.request !== 'function' ||
        typeof bridge.subscribe !== 'function' ||
        new URL(origin).origin !== origin ||
        !/^https?:$/.test(new URL(origin).protocol)
      )
        return fail('PROMOTION_UNSUPPORTED_BRIDGE');
      uuid(state.programId);
      const identity = await bridge.getIdentity();
      if (lease !== epoch || disposed) throw stale;
      if (!identity || identity.origin !== origin)
        return fail('PROMOTION_AUTH_REQUIRED');
      actor = { actorId: uuid(identity.actorId), origin };
      check(lease);
      journal = readJournal();
      if (journal) await recoverOriginal(lease);
      else await loadProgram(lease);
    } catch (error) {
      showError(error, lease);
    } finally {
      if (lease === epoch) {
        busy = false;
        emit();
      }
    }
  }
  if (
    bridge?.version === 'rating-group-promotion-v1' &&
    bridge.origin === origin &&
    typeof bridge.subscribe === 'function'
  ) {
    try {
      unsubscribe = bridge.subscribe(suspend);
    } catch {
      state.error = 'PROMOTION_UNSUPPORTED_BRIDGE';
    }
  }
  return {
    getState: () => structuredClone(state),
    connect,
    preview: (mode, testDestinationId) =>
      action(async (lease) => {
        if (journal || readJournal()) return fail('PROMOTION_REQUEST_PENDING');
        const program = state.program;
        if (
          !program ||
          !state.actions.includes('preview') ||
          !state.actions.includes(mode === 'test' ? 'test' : 'send')
        )
          return fail('PROMOTION_FORBIDDEN');
        if (
          (mode !== 'normal' && mode !== 'test') ||
          (mode === 'normal' && testDestinationId !== undefined) ||
          (mode === 'test' &&
            !state.destinations.some((item) => item.id === testDestinationId))
        )
          return fail('PROMOTION_INVALID_REQUEST');
        state.preview = null;
        state.payload = null;
        state.confirmation = null;
        state.phase = 'loading';
        emit();
        const row = await request(`${base()}/previews`, 'POST', lease, {
          type: program.type,
          mode,
          ...(mode === 'test' ? { testDestinationId } : {}),
          expectedProgramRevision: program.revision,
        });
        const preview: RatingPromotionOperatorPreview = {
          previewId: uuid(row['previewId']),
          type: program.type,
          mode,
          expectedProgramRevision: uuid(row['expectedProgramRevision']),
          expiresAt: date(row['expiresAt']),
          ...payload(row),
          audience: audience(row['audience']),
        };
        if (
          row['type'] !== program.type ||
          row['mode'] !== mode ||
          preview.expectedProgramRevision !== program.revision ||
          Date.parse(preview.expiresAt) <= now()
        )
          return fail('PROMOTION_PREVIEW_STALE');
        if (mode === 'test') {
          preview.testDestination = destination(row['testDestination']);
          if (
            preview.testDestination.id !== testDestinationId ||
            preview.audience.total !== 1 ||
            preview.audience.test !== 1 ||
            preview.audience.school !== 0 ||
            preview.audience.default !== 0
          )
            return fail('PROMOTION_INVALID_RESPONSE');
        } else if (
          preview.audience.test !== 0 ||
          row['testDestination'] !== undefined ||
          row['testDestinationId'] !== undefined
        )
          return fail('PROMOTION_INVALID_RESPONSE');
        state.preview = preview;
        state.phase = 'preview';
        state.error = null;
        state.confirmation =
          mode === 'test'
            ? `Send only to test destination “${preview.testDestination?.label}” (1 group)`
            : `Send to enrolled groups (${preview.audience.total} groups: ${preview.audience.school} school, ${preview.audience.default} default)`;
      }),
    confirm: (input) =>
      action(async (lease) => {
        const preview = state.preview;
        const program = state.program;
        if (journal || readJournal()) return fail('PROMOTION_REQUEST_PENDING');
        if (
          !preview ||
          !program ||
          input.previewId !== preview.previewId ||
          input.confirmation !== state.confirmation ||
          !state.actions.includes(preview.mode === 'test' ? 'test' : 'send') ||
          !program.copyModes.includes(input.copyMode) ||
          !program.linkModes.includes(input.linkMode)
        )
          return fail('PROMOTION_INVALID_REQUEST');
        if (Date.parse(preview.expiresAt) <= now())
          return fail('PROMOTION_PREVIEW_STALE');
        state.phase = 'sending';
        state.payload = null;
        emit();
        const row = await request(`${base()}/intents`, 'POST', lease, {
          previewId: preview.previewId,
          copyMode: input.copyMode,
          linkMode: input.linkMode,
        });
        const intent = parseIntent(row);
        if (Date.parse(intent.expiresAt) <= now())
          return fail('PROMOTION_INTENT_EXPIRED');
        const original = {
          origin,
          actorId: actor!.actorId,
          programId: state.programId,
          requestId: intent.requestId,
          ticketExpiresAt: intent.expiresAt,
          requestHash: intent.requestHash,
        };
        persist(original, lease);
        check(lease);
        // The journal contains no command or ticket. Re-fetch immutable intent even on first send.
        state.preview = null;
        state.confirmation = null;
        await recoverOriginal(lease);
      }),
    recover: () => action(recoverOriginal),
    sealOriginal: () =>
      action(async (lease) => {
        const original = journal ?? readJournal();
        if (!original) return fail('PROMOTION_NO_PENDING_REQUEST');
        readback(original);
        const cancelRequestId = uuid(
          (deps.randomUUID ?? (() => globalThis.crypto.randomUUID()))(),
        );
        const result = await request(
          `${base()}/requests/${original.requestId}/cancel`,
          'POST',
          lease,
          { cancelRequestId, requestHash: original.requestHash },
        );
        if (
          result['sealed'] !== true ||
          result['requestId'] !== original.requestId
        )
          return fail('PROMOTION_INVALID_RESPONSE');
        state.preview = null;
        state.payload = null;
        state.confirmation = null;
        if (result['status'] !== undefined)
          state.metadata = metadata(result['status'], original);
        // Only a durable seal, serialized with admission, permits an explicitly confirmed new intent.
        try {
          deps.storage.removeItem(key());
          if (deps.storage.getItem(key()) !== null)
            return fail('PROMOTION_JOURNAL_UNAVAILABLE');
        } catch {
          return fail('PROMOTION_JOURNAL_UNAVAILABLE');
        }
        journal = null;
        state.hasPendingRequest = false;
        state.phase = 'sealed';
        state.error = null;
        emit();
        await loadProgram(lease);
      }),
    clearPreview: () => {
      if (busy || disposed || journal || state.hasPendingRequest) return;
      state.preview = null;
      state.payload = null;
      state.confirmation = null;
      state.phase = state.program ? 'ready' : state.phase;
      emit();
    },
    inspectPayload: () =>
      action(async (lease) => {
        const original = journal ?? readJournal();
        const campaignId = state.metadata?.campaignId;
        if (!original || !campaignId)
          return fail('PROMOTION_NO_PENDING_REQUEST');
        state.payload = null;
        const result = await request(
          `/v1/rating-group-promotion/campaigns/${uuid(campaignId)}`,
          'GET',
          lease,
        );
        state.metadata = metadata(result, original);
        if (
          !state.metadata.payloadExpired &&
          result['payload'] !== undefined &&
          result['payload'] !== null
        )
          state.payload = payload(result['payload'], true);
      }),
    moreDestinations: () =>
      action(async (lease) => {
        if (state.nextDestinationCursor)
          await destinations(lease, state.nextDestinationCursor);
      }),
    suspend,
    navigate: async (programId) => {
      suspend();
      state.programId = programId;
      await connect();
    },
    dispose: () => {
      if (disposed) return;
      suspend();
      disposed = true;
      unsubscribe();
    },
  };
}

export function renderRatingGroupPromotionOperatorShell(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rating group promotion</title></head><body>
<main><h1>Rating group promotion</h1><p>Operational replacement for the legacy rating link URL. Synthetic-only; no live provider.</p>
<p id="promotion-status" role="status">A supported authenticated host is required.</p>
<form id="promotion-program-form"><label>Accepted program ID <input id="promotion-program-id" name="programId" autocomplete="off" maxlength="36"></label><button id="promotion-open" type="submit" disabled>Open program</button></form>
<section id="promotion-program" hidden><h2>Accepted program</h2><p id="promotion-program-summary"></p>
<label>Audience <select id="promotion-mode"><option value="normal">Enrolled school and default groups</option><option value="test">One enrolled test destination</option></select></label>
<label>Test destination <select id="promotion-test-destination" disabled></select></label><button id="promotion-more-destinations" type="button" hidden disabled>More test destinations</button>
<label>Copy <select id="promotion-copy-mode"></select></label><label>Link <select id="promotion-link-mode"></select></label>
<button id="promotion-preview" type="button" disabled>Preview locally</button></section>
<section id="promotion-preview-panel" hidden><h2>Local preview</h2><p id="promotion-copy"></p><p id="promotion-locator"></p><p id="promotion-audience"></p><button id="promotion-confirm" type="button" disabled>Send to enrolled groups</button></section>
<section id="promotion-recovery" hidden><h2>Original request</h2><button id="promotion-recover" type="button" disabled>Check original request</button><button id="promotion-seal" type="button" disabled>Cancel and seal original request</button><p>Cancellation suppresses future work. Confirmed or unknown messages may remain in groups.</p></section>
<section id="promotion-result" hidden><h2>Campaign status</h2><p id="promotion-counts"></p><p id="promotion-stages"></p><p id="promotion-stage-counts"></p><p id="promotion-retention"></p><button id="promotion-inspect" type="button" disabled>Inspect current payload</button><p id="promotion-current-copy"></p><p id="promotion-current-locator"></p></section>
</main><script type="module" src="${RATING_GROUP_PROMOTION_OPERATOR_SCRIPT_PATH}"></script></body></html>`;
}

/** DOM binding has no auth fallback, inline handlers, HTML injection, or arbitrary URL input. */
export function mountRatingGroupPromotionOperator(
  create: typeof createRatingGroupPromotionOperator,
  host: Window & {
    whaleuRatingGroupPromotionBridge?: RatingPromotionOperatorBridge;
  },
): RatingPromotionOperatorController {
  const document = host.document;
  function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error('Missing operator shell element');
    return value as T;
  }
  const input = element<HTMLInputElement>('promotion-program-id');
  const mode = element<HTMLSelectElement>('promotion-mode');
  const destination = element<HTMLSelectElement>('promotion-test-destination');
  const copy = element<HTMLSelectElement>('promotion-copy-mode');
  const link = element<HTMLSelectElement>('promotion-link-mode');
  const bridge = host.whaleuRatingGroupPromotionBridge ?? null;
  const supported =
    bridge?.version === 'rating-group-promotion-v1' &&
    bridge.origin === host.location.origin;
  const programId =
    new URLSearchParams(host.location.search).get('programId') ?? '';
  input.value = programId;
  let state: RatingPromotionOperatorState;
  function options(
    select: HTMLSelectElement,
    values: { value: string; label: string }[],
  ) {
    const previous = select.value;
    const signature = JSON.stringify(values);
    if (select.dataset['options'] === signature) return;
    select.replaceChildren(
      ...values.map((entry) => {
        const option = document.createElement('option');
        option.value = entry.value;
        option.textContent = entry.label;
        return option;
      }),
    );
    select.dataset['options'] = signature;
    if (values.some((entry) => entry.value === previous))
      select.value = previous;
  }
  function render(next: RatingPromotionOperatorState) {
    state = next;
    const ready = next.phase === 'ready' || next.phase === 'preview';
    const recovering =
      next.phase === 'recorded' ||
      next.phase === 'error' ||
      next.phase === 'sealed';
    element('promotion-status').textContent =
      next.error ??
      {
        blocked: 'A supported authenticated host is required.',
        loading: 'Loading current authority…',
        ready: 'Review the audience and preview before confirming.',
        preview: 'Confirm this exact audience.',
        sending: 'Preserving the original request…',
        recovering:
          'Checking the original request. No new key will be created.',
        recorded: 'Original request recorded.',
        sealed: 'Original request durably sealed.',
        error: 'Request unavailable.',
        hidden: 'View cleared. Reconnect to inspect current authority.',
      }[next.phase];
    element<HTMLButtonElement>('promotion-open').disabled =
      !supported || ['loading', 'sending', 'recovering'].includes(next.phase);
    element('promotion-program').hidden = !next.program;
    element('promotion-program-summary').textContent = next.program
      ? `${next.program.type} · ${next.program.programId} · ${next.program.audience.school} school groups, ${next.program.audience.default} default groups`
      : '';
    options(
      destination,
      next.destinations.map((item) => ({ value: item.id, label: item.label })),
    );
    options(
      copy,
      (next.program?.copyModes ?? []).map((value) => ({ value, label: value })),
    );
    options(
      link,
      (next.program?.linkModes ?? []).map((value) => ({ value, label: value })),
    );
    mode.disabled = !ready;
    copy.disabled = !ready;
    link.disabled = !ready;
    destination.disabled = !ready || mode.value !== 'test';
    element<HTMLButtonElement>('promotion-preview').disabled =
      !ready ||
      next.hasPendingRequest ||
      !next.actions.includes('preview') ||
      !next.actions.includes(mode.value === 'test' ? 'test' : 'send');
    element('promotion-more-destinations').hidden =
      next.nextDestinationCursor === null;
    element<HTMLButtonElement>('promotion-more-destinations').disabled = !ready;
    element('promotion-preview-panel').hidden = next.preview === null;
    element('promotion-copy').textContent = next.preview?.copy ?? '';
    element('promotion-locator').textContent = next.preview?.locator ?? '';
    element('promotion-audience').textContent = next.confirmation ?? '';
    element('promotion-confirm').textContent =
      next.confirmation ?? 'Send to enrolled groups';
    element<HTMLButtonElement>('promotion-confirm').disabled =
      next.phase !== 'preview' || next.hasPendingRequest;
    element('promotion-recovery').hidden = !next.hasPendingRequest;
    element<HTMLButtonElement>('promotion-recover').disabled =
      !recovering || !next.hasPendingRequest;
    element<HTMLButtonElement>('promotion-seal').disabled =
      !recovering || !next.hasPendingRequest;
    element('promotion-result').hidden = next.metadata === null;
    element('promotion-counts').textContent = next.metadata
      ? `Confirmed: ${next.metadata.counts.confirmed}. Unknown: ${next.metadata.counts.unknown}. Not sent: ${next.metadata.counts.notSent}. Pending: ${next.metadata.counts.pending}.`
      : '';
    element('promotion-stages').textContent = next.metadata
      ? `Admission: ${next.metadata.admission}. Composition: ${next.metadata.composition}. Delivery: ${next.metadata.delivery}. Cancellation requested: ${next.metadata.cancelRequested ? 'yes' : 'no'}.${next.metadata.remoteMessageMayRemain ? ' Historical accepted or unknown messages may remain.' : ''}`
      : '';
    element('promotion-stage-counts').textContent = next.metadata?.stages
      ? Object.entries(next.metadata.stages)
          .map(
            ([stage, counts]) =>
              `${stage}: ${counts.confirmed} confirmed, ${counts.unknown} unknown, ${counts.notSent} not sent, ${counts.pending} pending`,
          )
          .join('. ')
      : '';
    element('promotion-retention').textContent = next.metadata?.payloadExpired
      ? 'Payload expired. Historical metadata only.'
      : '';
    element<HTMLButtonElement>('promotion-inspect').disabled =
      !recovering || !next.metadata?.campaignId || next.metadata.payloadExpired;
    element('promotion-current-copy').textContent = next.payload?.copy ?? '';
    element('promotion-current-locator').textContent =
      next.payload?.locator ?? '';
  }
  let storage: RatingPromotionOperatorStorage;
  try {
    storage = host.localStorage;
  } catch {
    storage = {
      getItem: () => {
        throw new Error('Storage unavailable');
      },
      setItem: () => {
        throw new Error('Storage unavailable');
      },
      removeItem: () => {
        throw new Error('Storage unavailable');
      },
    };
  }
  const controller = create({
    origin: host.location.origin,
    programId,
    bridge,
    storage,
    getOrigin: () => host.location.origin,
    onChange: render,
  });
  render(controller.getState());
  element('promotion-program-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void controller.navigate(input.value.trim());
  });
  for (const select of [mode, destination, copy, link])
    select.addEventListener('change', () => {
      controller.clearPreview();
      render(state);
    });
  element('promotion-preview').addEventListener('click', () => {
    void controller.preview(
      mode.value === 'test' ? 'test' : 'normal',
      mode.value === 'test' ? destination.value : undefined,
    );
  });
  element('promotion-confirm').addEventListener('click', () => {
    if (!state.preview || !state.confirmation) return;
    void controller.confirm({
      previewId: state.preview.previewId,
      confirmation: state.confirmation,
      copyMode: copy.value as 'deterministic' | 'assisted',
      linkMode: link.value as
        'native' | 'shortlink_optional' | 'shortlink_required',
    });
  });
  element('promotion-recover').addEventListener('click', () => {
    void controller.recover();
  });
  element('promotion-seal').addEventListener('click', () => {
    void controller.sealOriginal();
  });
  element('promotion-inspect').addEventListener('click', () => {
    void controller.inspectPayload();
  });
  element('promotion-more-destinations').addEventListener('click', () => {
    void controller.moreDestinations();
  });
  host.addEventListener('pagehide', () => controller.suspend());
  host.addEventListener('beforeunload', () => controller.suspend());
  host.addEventListener('popstate', () => {
    controller.suspend();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') controller.suspend();
    else if (supported) void controller.connect();
  });
  if (supported && programId) void controller.connect();
  return controller;
}

export function ratingGroupPromotionOperatorModuleSource(): string {
  // The development TS loader adds name-only helpers; production tsc does not.
  return `const __name = (value) => value;\nconst createRatingGroupPromotionOperator = ${createRatingGroupPromotionOperator.toString()};\nconst mountRatingGroupPromotionOperator = ${mountRatingGroupPromotionOperator.toString()};\nmountRatingGroupPromotionOperator(createRatingGroupPromotionOperator, window);\n`;
}
