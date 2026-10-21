# Native Following contract and recovery

## Implemented scope

The native Home `关注` pane uses `FollowingGateway.feed` instead of the ordinary
community feed. It retains the selected community, category, trading subtype,
cursor and existing content-policy checks. It is not an all-campus aggregation.
Only named public-author posts are accepted. Anonymous personas cannot be turned
into follow targets. Campus/global pin projections are neither loaded nor rendered
inside Following; an ordinary followed post is not suppressed merely because its
ID matches a campus pin.

An available, non-own public profile exposes the Follow action. A private/hidden
profile list is not opened by following. Guest, missing runtime, unknown state,
empty feed and failed reads remain distinct states; none use sample content,
recommendations, invented counts or inferred private identities.

## Mutation safety

- `PendingFollowStore` persists one immutable unresolved intent per actor and API
  origin: account ID, named profile ID, desired boolean and request UUID.
- Persistence and read-back validation precede dispatch. Corrupt/unwritable storage
  blocks sends. Duplicate taps cannot create another UUID.
- Page entry, target changes and account changes never replay a command. Recovery
  requires an explicit retry on the original profile, retaining exactly the
  original UUID, actor, target and desired state.
- If another profile is open, its Follow action remains frozen and links back to
  the original public profile. An already-journaled target remains explicitly
  recoverable after becoming unavailable, but cannot create a new follow intent.
- A mutation response is a historical acknowledgement, not current truth. After
  validating and clearing the matching journal, the controller reads authoritative
  status before rendering followed/unfollowed. A failed status read stays unknown.
- An allowlisted, persisted terminal rejection also carries the original request
  UUID, profile ID and desired state. Only an exactly matching verified receipt
  releases the actor-wide barrier. The UI explains the rejection and keeps current
  follow state unknown until a fresh read. A bare HTTP/policy error, unexpected
  code, mismatched receipt or uncertain outcome never discards the journal.
- Account/login-epoch changes, root hide, target changes and cancellation fence
  late callbacks. Cancellation does not claim the server cancelled a mutation.
  Unacknowledged intents remain stored under the original account only.

## Feed lifecycle and exposure

`FeedController` switches explicit source before a request, clears rows and cursors,
and cancels prior waits. Its Following source requires login and a real Following
gateway, with no ordinary-feed fallback. Pagination still deduplicates IDs and
rejects a non-advancing cursor.

Leaving Following resolves the requested regional/global community in the same
state transition. It never fetches or waits for the previous hidden community
before opening the new one; multiple global choices still require an explicit
selection.

Native Home exposure uses source-prefixed scopes and observes only IDs whose source
matches the visible pane. Actual viewport/dwell evidence remains the only exposure
trigger. Hidden-tab responses do not record exposure or restore hidden cards. The
waterfall presentation, where present, partitions the already-filtered actual posts;
it does not change post identity or the flattened observation list.

## Evidence and release boundaries

`apps/wechat/test/following-controller.test.ts` covers guest/no-runtime behavior,
unknown-command retries, duplicate taps, historical acknowledgements, original
profile recovery, storage failures, actor/target/hide/cancel races, named-only feed,
source changes, verified terminal-rejection settlement and native Home pin/exposure
behavior. Gateway contract tests remain
in `following-gateway.test.ts`. Existing community read and safety tests continue
to cover inherited feed scope and actor fences.

Native build/emitted smoke and focused unit/type checks are local synthetic
verification. They do not activate a production provider, apply a live migration,
prove real follow relationships, or replace WeChat DevTools and real-device QA.
Production schema rollout, deployed API compatibility, device/accessibility checks,
and real authorized account acceptance remain release gates.
