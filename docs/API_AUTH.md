# Identity and authentication: first vertical slice

Status: implemented in the greenfield NestJS API; not production-ready and not
full account-feature parity. No legacy routes, envelopes, cookies or dual-live
compatibility layer are introduced. No production database or real WeChat account
has been contacted or migrated.

## New HTTP contract

All routes are under `/v1/auth`. Use HTTPS in deployment. Requests contain no
client-supplied account IDs, openids, roles or school permissions. DTOs reject
unknown fields, wrong types, whitespace-only codes and oversized strings.

| Operation            | Request                                           | Success          |
| -------------------- | ------------------------------------------------- | ---------------- |
| `POST /wechat/login` | JSON `{ "code": "wx.login temporary code" }`      | 200 credentials  |
| `POST /refresh`      | JSON `{ "refreshToken": "opaque refresh token" }` | 200 credentials  |
| `GET /session`       | `Authorization: Bearer <accessToken>`             | 200 session view |
| `POST /logout`       | `Authorization: Bearer <accessToken>`             | 204, empty body  |

Credentials are a direct object:

```json
{
  "accountId": "UUIDv4",
  "sessionId": "UUIDv4",
  "accessToken": "wu_a_<43 base64url characters>",
  "refreshToken": "wu_r_<43 base64url characters>",
  "expiresAt": 1800000000000,
  "refreshExpiresAt": 1800600000000
}
```

The session view has the same account/session IDs and expiration fields, with
neither token. All expiration timestamps are integer epoch milliseconds and
`expiresAt <= refreshExpiresAt`. These example timestamps and strings are
illustrative, not working credentials. Responses are marked `no-store`.

Error shape: `{ "error": { "code": "...", "message": "safe text", "requestId": "UUID" } }`.
Do not branch on translated message text.

- 400 `BAD_REQUEST`: invalid body/schema, including cross-purpose refresh inputs
- 401 `AUTHENTICATION_REQUIRED`: missing, malformed, wrong-purpose or unknown bearer token
- 401 `LOGIN_REJECTED`: provider rejects the temporary login code
- 401 `ACCESS_TOKEN_EXPIRED`: known expired/rotated access token
- 401 `REFRESH_TOKEN_EXPIRED`: refresh/session lifetime expired
- 401 `REFRESH_TOKEN_REUSED`: consumed refresh token replay; session was revoked
- 401 `SESSION_REVOKED`: session has been revoked
- 403 `ACCOUNT_BLOCKED`: current account state denies access
- 429 `RATE_LIMITED`: identity risk budget exhausted
- 503 `AUTH_NOT_CONFIGURED`: required provider/risk configuration is absent
- 503 `IDENTITY_PROVIDER_UNAVAILABLE`: provider transport, quota or response failure

The existing phone-verification and moderation error codes remain definitions;
this module does not implement those business capabilities.

## Session security and client behavior

- Access and refresh credentials are separate 256-bit random opaque values, not
  JWTs. Different prefixes enforce token purpose at HTTP and service boundaries
- Only SHA-256 token fingerprints are persisted. High entropy makes an additional
  token-hashing pepper unnecessary. No signing key or insecure fallback secret
  exists. TLS and secret-safe client storage are still deployment requirements
- Access lifetime is ten minutes; refresh is seven days sliding, capped at the
  session's fixed thirty-day lifetime. Time decisions use the PostgreSQL clock
- Every access lookup joins current account and session state. Blocking/revoking
  takes effect for later authorization checks; tokens contain no stale role claims
- Every refresh is single-use and rotates both credentials in one transaction
- Refresh requests lock the session row and re-read token consumption after the
  lock. Concurrent duplicates cannot both succeed. Replay revocation is committed
  before the API returns its error, rather than rolled back by throwing in the
  transaction
- A replay revokes only that session, not every device belonging to the account
- The client must serialize refresh, preserve session lineage and never
  automatically retry a refresh after a timeout or lost response. A fresh login
  is required if the result is uncertain. There is deliberately no replay grace
  interval or stored plaintext replacement token. This accepts a usability cost
  to avoid making a stolen consumed token usable again
- Old access hashes are retained with expired semantics. A late request sees
  `ACCESS_TOKEN_EXPIRED`; it does not authenticate as a different account
- Logout accepts a known historical access token even if expired. Its only power
  is revoking that same session, making logout safe during refresh races or a
  lost response. Repeated known-session logout is idempotent; unknown tokens fail
- New logins are serialized by app-scoped provider identity. One account is
  created under concurrency. At most ten non-expired, non-revoked device sessions
  remain active; older sessions are revoked when the limit is exceeded
- No token, login code, provider URL, provider response, raw address or user ID is
  written by this module to application logs. Generic exception logging is
  sanitized; defensive credential-field redaction also covers the new fields

Anonymous campus activity is a separate domain requirement. Authentication does
not publish provider identifiers, invent a phone number or claim an account is
phone/school verified. Public profile and anonymous author presentation are not
implemented by this slice.

## Provider boundary and configuration

`IdentityProvider` is injectable. Production wiring selects
`WechatIdentityProvider`; all tests inject a synthetic provider or mock fetch.
The adapter calls only the fixed HTTPS WeChat `jscode2session` endpoint, with
certificate verification, no redirects, a five-second deadline, no automatic
retry and an 8 KiB response limit. It validates provider errors, openid and session
key shape. The session key is discarded. The returned identity is scoped to the
configured application; any union ID is private mapping evidence, never authority
to merge accounts automatically.

Configure all three together through an approved secret-management process:

- `WECHAT_APP_ID`: expected `wx` plus sixteen lowercase hexadecimal characters
- `WECHAT_APP_SECRET`: provider-issued secret; server only
- `AUTH_RATE_LIMIT_KEY`: independently provisioned 32-byte cryptographic random
  HMAC key encoded as 64 hexadecimal characters; server only, identical across
  API replicas. No key generation, credential setup or production secret is
  included in this work. Hex shape validation does not prove entropy

Absent configuration keeps health checks usable and login/refresh/logout fail
closed. Partial or malformed configuration prevents boot with field names only.
Do not put these values in a mini-program, checked-in environment file or logs.
No signing key, paid API or AI service is required.

The adapter's protocol follows the documented WeChat mini-program login flow and
existing source's server exchange. The official references are
[code2Session](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html)
and [login flow](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html).
The official pages could not be retrieved in this environment, and no live
provider integration has been exercised. Reconfirm the app's provider settings,
error behavior and approved server/network configuration before production use.

## Risk controls and operating limitations

Identity mutations consume atomic PostgreSQL fixed-minute buckets: twenty login
attempts or sixty refresh/logout attempts per peer address, plus a 300-per-minute
budget per operation shared across replicas. A keyed HMAC stores each address's
bucket without recording the address. Expired buckets receive bounded
opportunistic cleanup. Fixed-window boundaries can admit a burst spanning two
minutes; these controls are a first-layer budget, not a complete abuse platform.

Only the socket peer address is trusted. `X-Forwarded-For` cannot bypass the limit.
Behind a proxy all clients may share its budget. Before deployment, choose a
reviewed edge/trusted-proxy policy and suitable budgets for the expected traffic.
A shared edge limit must also bound invalid bodies, unauthenticated reads,
connection exhaustion and distributed attacks. No arbitrary forwarded-header
trust, CAPTCHA flow or device fingerprinting has been added.

Session/access/refresh history remains necessary while a session can be used.
Refresh updates use the `(session_id, expires_at)` index and touch only currently
live access-token rows, avoiding repeated rewrites of all older history. The
live-session cap alone does not bound historical storage; use the explicit
operator maintenance workflow below after approving its retention policy.

## Internal credential-state maintenance

`IdentityMaintenance` and `auth:maintain` provide a bounded cleanup mechanism.
There is no public route, startup hook, scheduler or automatic production run.
No production cleanup was executed in this work.

From the repository root, preview using the currently selected database:

```sh
npm run auth:maintain -w @whaleu/api
npm run auth:maintain -w @whaleu/api -- dry-run --retention-days=90 --batch-size=100
```

Only after an operator has reviewed the database, retention requirement, audit
obligations and preview, explicitly apply a bounded number of batches:

```sh
npm run auth:maintain -w @whaleu/api -- apply --retention-days=90 --batch-size=100 --batches=5
```

In `NODE_ENV=production`, apply additionally requires the literal
`--allow-production` flag. This is an operator safety interlock, not permission
to discard production data. Set the environment correctly; never change it to
bypass the interlock. Production execution still needs separate authorization
and a reviewed retention/backup/incident-investigation policy. A database role
with the minimum required session/token privileges is preferred; no role grants
or production access were configured by this implementation.

Controls and guarantees:

- Dry-run is the default and executes a repeatable-read, read-only transaction
  without row locks or mutations. It previews one bounded batch, not the entire
  backlog. Changes after that snapshot can change a later apply result
- Retention is 30 days after a session becomes unusable by default, configurable
  from 1 to 3650 days. A session is terminal when revoked or when refresh has
  expired; the schema prevents access from outliving refresh. An account being
  blocked alone does not make its still-live session eligible
- The cutoff uses PostgreSQL time. Apply selects at most 100 terminal sessions,
  locking them with `FOR UPDATE SKIP LOCKED`. A concurrently rotating/locked
  session is skipped rather than having its lineage partially erased
- Each batch deletes at most `batch-size` rows in TOTAL across access hashes,
  refresh hashes and session rows. `batch-size` is bounded from 1 to 1000; apply
  runs from 1 to 100 batches, default 1. A single session with many hashes is
  drained across multiple batches; deleting a parent never triggers an unbounded
  cascade because deletion requires both child histories to be empty
- Only the three credential-state tables are deleted from. Accounts, provider
  identities, legacy ID mappings, profiles, business data and migration history
  are not modified. `0002_identity_retention_index.sql` adds only an index
- Active refresh replay evidence is preserved. Expired/revoked credentials remain
  until their selected terminal retention has elapsed. After cleanup an old
  credential becomes unknown (401) and its old logout request is no longer
  idempotently accepted; it cannot regain access
- Each batch is one transaction and rolls back on failure. PostgreSQL connection,
  statement and idle-transaction timeouts still apply. The row budget bounds
  mutations, not arbitrary database scan time; the terminal-time and token/session
  indexes support the bounded queries
- Output contains counts only. There are no identifiers, hashes or secrets in
  maintenance reports. A zero-work result can mean eligible rows are locked by
  another operation; it is not a certification that every old record is gone

The deleted state is an authentication operating record, not an audit archive.
If an incident or retention obligation requires those session/revocation records,
do not apply cleanup until the appropriate preservation decision is made. This
slice does not implement a separate immutable security audit archive. Its
maintenance facility does not waive the full production business-data migration
requirement or authorize deleting old production business records.

An operational cadence and retention policy still need deployment review and
explicit enabling; no automation was added. Rate buckets receive their existing
short-lived bounded cleanup separately. Rotate risk keys only under an explicit
deployment plan, because changing a key resets those buckets. No automatic retry
is made for an uncertain database commit or provider exchange.

## Schema and production migration boundary

`0001_identity_sessions.sql` is an immutable versioned new-schema migration,
executed only by the existing PostgreSQL 18.6+ runner. Startup never applies it.
It creates accounts, app-scoped provider identities, legacy ID mappings,
sessions, access hashes, refresh lineage and risk buckets. The schema constrains
expiry ordering, token hash shapes, account state and revocation consistency.

Legacy account IDs are text in `(source_system, legacy_id)` mapping rows so large
IDs are not rounded through JavaScript. Accounts use new UUIDs. Future import
must reconcile and populate provider identity/account mappings before allowing
existing users to sign in, or an unmapped identity could create a new account.
Storing a mapping table is not an importer or proof of preserved data.

Source cross-check: legacy `User.php` login/profile paths at the inventoried
source revision include registration, avatar/title defaults, phone fields,
school/verified university/campus/admin region, UID and union/official-account
mapping. Those requirements remain open. This slice intentionally does not claim:

- User profile, nickname/avatar/bio/title/background editing or default allocations
- Phone verification, student/school verification and evidence/privacy workflows
- School selection, verified school/campus, admin geography or role/scope permissions
- UID migration, moderation/ban management UI or role administration
- Union/official-account account linking, mapping conflict resolution or merge flows.
  The initial union ID is stored privately when present on first registration;
  enrichment when it first appears on a later login is also pending. No automatic
  merge is performed
- Unread state, uploaded media, official-account tip/subscription state
- Existing production records, provider app mappings, media, ledger or any other
  business-data migration, reconciliation, cutover or rollback rehearsal

The available controller inventory was inspected without executing legacy PHP;
no authoritative legacy User model/schema was available in the checked source
cache. A complete source-schema/export review is required for the importer.
All old business features and all production data remain required in the larger
rewrite. This module is the first authentication slice, not completion of them.

## Verification

API unit and in-process HTTP tests exercise token-purpose separation, strict
input bounds, provider errors/response limits, disabled configuration, sanitized
errors, no-store headers, hash-only persistence calls and the direct contracts.
Tests use synthetic secrets and intercepted transports exclusively.

`npm run test:integration` runs integration files serially against a new local
`whaleu_test` database and refuses existing application/migration schemas. The
identity suite applies the real checked-in SQL through the migration runner,
then covers transactional rollback, simultaneous account creation, session caps,
refresh replay/concurrency, logout races, expiry, blocking, absolute lifetime,
app scoping, large legacy ID preservation, shared risk buckets, non-mutating
maintenance previews, tiny bounded cleanup batches, active-lineage preservation,
mapping preservation and locked-session skipping. It removes
only the schemas it created. Missing configuration is a failure, never a skip.

No PostgreSQL or Docker executable is available in the current development
container. The new integration suite has been type-checked but requires the
PostgreSQL 18.6 CI job before its runtime behavior can be called verified. Earlier
foundation-only CI does not verify this new module.
