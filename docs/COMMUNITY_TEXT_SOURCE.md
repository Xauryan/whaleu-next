# Community immutable text source

## Current implementation and activation boundary

Formal migration `0175_community_text_sources.sql`, Review v6, source publication/read contracts and native plain/Markdown draft editing are implemented on c27. Current local HTTP/PostgreSQL/native checks have passed in the exact-input scopes documented in [READING_C27_INTEGRATION.md](READING_C27_INTEGRATION.md). This is not production deployment, external-provider or physical-device acceptance.

`COMMUNITY_TEXT_REVIEW=source_manual` permits explicitly configured human source review in production. It requires the actual scope, operator and accepted source policy, not just a flag. The default remains disabled. Original-source publication and the six authorized native readers work without M2; optional deterministic formatting is separately installed by formal 0176 and separately enabled. See [COMMUNITY_SOURCE_MANUAL_DEPLOYMENT.md](COMMUNITY_SOURCE_MANUAL_DEPLOYMENT.md) and [M2_DEPLOYMENT.md](M2_DEPLOYMENT.md).

The source/descriptor core preserves the reviewed format union, CRLF-only canonicalization, scalar/control limits and digest. Draft text is editable before freezing; pending intent and published source are not. No published editing API, inline Markdown media, full-source Markdown reference AST or external provider activation is implemented. Source/M2 erasure qualification remains excluded and fail closed.

## Request DTO: additive, explicit only

Existing authenticated routes remain:

| Operation       | Review preparation (HTTP 200)                              | Publication (HTTP 201)                             |
| --------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| publish_post    | POST /v1/community/reviews/posts                           | POST /v1/community/posts                           |
| publish_comment | POST /v1/community/reviews/posts/:postId/comments          | POST /v1/community/posts/:postId/comments          |
| publish_reply   | POST /v1/community/reviews/comments/:rootCommentId/replies | POST /v1/community/comments/:rootCommentId/replies |

The original body gains exactly one optional property:

```ts
type TextSourceDescriptor =
  | { version: 1; format: 'plain'; readingFormatting: 'auto' | 'off' }
  | { version: 1; format: 'markdown' };
```

Omit it for historical plain-text semantics. Never infer Markdown or opt-in from `**`, `#`, a parent, or old stored text. `null`, unknown fields, a client `sourceHash`, `sourceRevision`, Markdown `readingFormatting`, or unknown versions are invalid, never a legacy downgrade.

```json
{
  "clientRequestId": "10000000-0000-4000-8000-000000000001",
  "spaceId": "10000000-0000-4000-8000-000000000002",
  "category": "discussion",
  "text": "Exact original text\r\n第二行",
  "imageAssetIds": [],
  "authorMode": "named",
  "commentsPolicy": "open",
  "allowAnonymousDm": false,
  "textSource": { "version": 1, "format": "plain", "readingFormatting": "auto" }
}
```

Source post fields: `clientRequestId` UUIDv4, `spaceId` UUID, `category`, nonblank `text`, `authorMode`, optional empty `imageAssetIds` (default []), optional `commentsPolicy` (default open), optional named-only `allowAnonymousDm:false`. It may omit `allowAnonymousDm`; absent and false stay distinct original intent/Review evidence. Optional `component:{kind:'none'}` and `syncToRelatedCampuses:false` preserve their historical omission from normalized intent. No feedback/trading/rating-link/poll/formation/related synchronization/restricted-comments/new-DM opt-in.

Source comment fields: `clientRequestId`, `text`, `authorMode`, optional empty `imageAssetIds`, `textSource`. Post ID comes only from the path. Source reply adds optional `targetReplyId` UUID or null (default null), root ID comes only from path. Parent/root/target must satisfy existing current ordinary authorization. Source admission additionally rejects parents that are reclassified, owner-hidden, related/special, restricted-comments or DM-opted-in. Authorized original anonymous behavior is unchanged; source classification never inherits from any ancestor.

Use lowercase canonical UUIDs in all new-source bodies/paths. Post request/space and comment request IDs reject uppercase; comment post path rejects uppercase at source admission. Existing reply transforms already canonicalize request/root/target IDs, unchanged. New source read path requires lowercase IDs. Do not alter old absent-descriptor normalization.

`text` is original authored text; canonical storage replaces only CRLF with LF. No trimming/NFC/entity/Markdown rewriting. Maximum: 2500 Unicode scalar values for posts, 500 for comments/replies. Existing control/surrogate restrictions apply. No format adds to scalar length. Every initial source publication is text-only: nonempty image IDs and Markdown `whaleu-asset:` markers are unavailable.

**Temporary Markdown reference fence:** any ASCII `/#[0-9]/` occurrence anywhere in original Markdown text is unavailable, including code, links, images, escapes and literals with lengths other than valid 7–9-digit references. This is deliberately conservative. It is not a parser or a completed reference-exclusion implementation. Plain references and permanent reference allocation remain unchanged. Remove this fence only after full-source native AST/context integration and every old detail consumer are independently validated; never recognize substrings and silently drop references.

## Capability DTO, version 1

`GET /v1/community/text-source-capabilities?spaceId=<uuid>&category=<category>&authorMode=named|anonymous`, authenticated, strict query, no-store, Vary: Authorization.

```ts
type TextSourceCapability = {
  version: 1;
  authorMode: 'named' | 'anonymous';
  availability: 'available' | 'unavailable';
  operations: ('publish_post' | 'publish_comment' | 'publish_reply')[];
  formats: ('plain' | 'markdown')[];
  readingFormatting: ('auto' | 'off')[];
  media: 'unavailable';
  markdownReferences: 'unavailable';
  formatter: 'not_configured';
};
```

The query requires an explicit authorMode, with no named default; the response echoes it. Unavailable has three empty arrays. Available has a nonempty unique operation subset for this requested identity and scope only, formats exactly `['plain','markdown']`, readingFormatting exactly `['auto','off']`. It requires current actor/scope/publication authority and an explicitly configured current complete accepted `local-text-source-v1` Review policy with the configured issuer. This is an advisory format availability check, not a publication permit for all identities or targets. Child operations use the least restrictive possible ordinary named parent for the scope-only check. Actual parents may deny or force effective anonymous mode; existing target-specific capabilities and actual current publication guards remain required. It does not promise a particular parent or future submit remains authorized. Existing capabilities and all old DTO exact keys are unchanged.

No default source policy or public provider exists. `COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID` is accepted with explicit production-capable `source_manual`, or with nonproduction `local_manual`; it is not an independent switch. `init-source-policy` is an explicit authorized human-operator action and is not performed by migrations or startup. In `source_manual`, unrelated policy/scope administration is rejected. Existing `init-policy` cannot admit v6. Real disposable API/PTY tests have exercised this flow; no production policy or service was activated. The historical policy key `local-text-source-v1` does not imply a current nonproduction-only restriction.

## Source response DTO, version 1

`GET /v1/community/text-sources/:kind/:id`, `kind=post|comment|reply`, lowercase UUID, empty query, authenticated, no-store, Vary: Authorization.

```ts
type SourceIdentity = {
  version: 1;
  kind: 'post' | 'comment' | 'reply';
  id: string;
  postId: string;
  rootCommentId: string | null;
  text: string;
};
type SourceResponse =
  | (SourceIdentity & { classification: 'legacyPlain' })
  | (SourceIdentity & {
      classification: 'reviewedSource';
      sourceRevision: 1;
      textSource:
        | {
            version: 1;
            format: 'plain';
            readingFormatting: 'auto' | 'off';
            sourceHash: string;
          }
        | { version: 1; format: 'markdown'; sourceHash: string };
      readingFormattingEligible: boolean;
      presentationStatus: 'not_configured' | 'ineligible';
    });
```

Exact identity: post `id=postId`, rootCommentId null; comment `id=rootCommentId`; reply rootCommentId nonnull. No account ID, Review decision, policy internals, author hidden identity, assets, HTML or parsed AST are exposed. Strict union rejects unknown fields. `legacyPlain` has no invented hash, revision, eligibility or new review claim. It still requires the same current canonical Review/Media/parent/account/Safety/scope proof. Root/reply classification is independent.

`sourceHash = SHA256(UTF8('whaleu-community-text-source:v1\n' + format + '\n' + canonicalText))`, lowercase 64 hex. Hash intentionally omits readingFormatting: auto/off share a source hash but have distinct Review digests and original intent hashes. Eligible is true only plain-auto and scalar length >=300 post or >=200 child. Eligible returns not_configured, otherwise ineligible. Neither value activates a formatter.

Read uses one managed transaction: authenticate/current account, canonical parent-first accessiblePost/Comment/Reply including current Review/Media/Safety/scope, current binding, independently reconstructed source body/row, final managed proofs. No detail-check followed by an unguarded second transaction. Missing/malformed/mismatched source metadata is unavailable, not legacyPlain. Denial is not a formatting failure and grants no cached source/legacy fallback permission.

## Responses, errors and client recovery

No new error code is introduced. HTTP error exact shape remains `{error:{code:string,message:string,requestId:string}}`. Existing successful publication receipt remains `{requestId,operation,outcome:'created',resourceId,createdAt}`; terminal rejection receipt remains `{requestId,operation,outcome:'rejected',code}`. Review status exact shape remains `{requestId,operation,status}` with pending/approved/rejected/unavailable/settled/cancelled.

| Situation                                                                                                  | Existing transport/code                                                                                                                            | Native handling                                                               |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Unknown/malformed descriptor, unknown fields, bad kind/query/id, invalid text, unsupported DTO combination | 400 BAD_REQUEST                                                                                                                                    | Fix local draft; never strip descriptor and retry silently.                   |
| Missing, expired or revoked identity/session                                                               | 401 AUTHENTICATION_REQUIRED / ACCESS_TOKEN_EXPIRED / SESSION_REVOKED                                                                               | Stop source rendering/recovery for that account; reauthenticate deliberately. |
| Blocked account or ineligible actor/phone/student/author mode/action                                       | Existing 403 ACCOUNT_BLOCKED / PHONE_VERIFICATION_REQUIRED / STUDENT_VERIFICATION_REQUIRED / AUTHOR_MODE_NOT_ALLOWED / COMMUNITY_ACTION_RESTRICTED | Preserve draft privately; no denied-source fallback.                          |
| Same original request with different format/auto-off/text/target/intent                                    | 409 REQUEST_CONFLICT                                                                                                                               | Reconcile existing original receipt; do not manufacture retry IDs.            |
| Cancelled original publication                                                                             | Existing 409 MEDIA_REQUEST_CANCELLED                                                                                                               | Respect cancellation fence; no automatic re-creation.                         |
| Current parent/resource missing/deleted/denied                                                             | 404 POST_NOT_FOUND / COMMENT_NOT_FOUND / REPLY_NOT_FOUND, 410 POST_DELETED, or existing current-proof unavailable code                             | Clear/deny display; no fallback source.                                       |
| Explicit source Review unavailable, unsupported media/Markdown reference/parent combination                | 503 CONTENT_REVIEW_UNAVAILABLE                                                                                                                     | Keep unchanged local draft; unavailable is not approval or opt-out.           |
| Scope/current independent proof unavailable                                                                | 409 COMMUNITY_SCOPE_UNAVAILABLE or 503 COMMUNITY_UNAVAILABLE                                                                                       | Fail closed, keep authorization separate from formatting.                     |
| Explicit Review rejection                                                                                  | Existing CONTENT_REVIEW_REJECTED / CONTENT_REJECTED, HTTP 422 or original terminal receipt as existing publication owner dictates                  | Render rejected state; do not rewrite or resubmit silently.                   |

A source GET never returns a publication receipt. Capability unavailable is HTTP 200 with empty arrays only when the authenticated capability owner can return a negative capability; authentication/current authority errors remain errors. Do not branch on message strings or assume every rejection is transport 4xx: original publication terminal receipts are preserved.

Native pending journal must bind original account, operation, request ID, target ancestry, original raw/canonical text and descriptor. Format/auto-off changes are material intent changes, not preview changes. Do not add a request ID on recovery; use original cancellation/review/receipt logic. The reply's original requested author mode and original hash remain distinct from effective forced-anonymous Media/Review context. Source hash alone is not a journal key or authorization proof. The native source-aware pending/journal integration preserves this contract; it does not upgrade descriptor-free historical drafts.

## Original-intent hash for native cancellation/recovery

For an explicit descriptor only: `SHA256(UTF8('whaleu-community-text-source-intent:v1\n' + JSON.stringify({operation, intent})))`, lowercase hex. This is ordered JSON serialization, **not** alphabetically sorted canonical Review JSON. The outer order is operation then intent. Intent field order:

- post: spaceId, category, canonical text, imageAssetIds, requested authorMode, commentsPolicy, optional allowAnonymousDm (only if explicitly present), textSource.
- comment: postId, canonical text, imageAssetIds, requested authorMode, textSource.
- reply: rootCommentId, targetReplyId (including null), canonical text, imageAssetIds, requested authorMode, textSource.
- Descriptor order: version, format, then readingFormatting for plain only. Never include sourceHash in original intent. Empty imageAssetIds is present; defaults are applied exactly as request parsing. Explicit component none and sync false are omitted from normalized intent as before.

Reply effective Review/Media context additionally incorporates postId and effective authorMode through the existing replyApprovalHash. Never substitute it for original publication/cancellation/journal identity. Absent textSource keeps the entire historical hash path unchanged, including v5 rating-card and v4 synchronization behavior. No server or native hidden rewrite/retry ID is introduced.

## Persistence, effects and consumers

Migration 0175 only, with no 0174 or old-migration edits: immutable source columns, no duplicate text body, no updates/backfill. Exact original content/account/request/intent/decision/digest/TX is independently joined to binding, receipt, report origin and outbox at commit. Source insert precedes Review binding. Deferred completeness and fresh current authority fences reject detached metadata. Source mode/hash/policy are canonical Review v6 evidence, not a sidecar authorization. All Media/content revisions stay 1.

Original allocator assigns a permanent number only; it does not scan content. Existing references/rewards/notices/receipts remain in original publication savepoint/TX with exactly-once effects. Existing detail/feed/count/search/visibility/reply/Saved/notification owners reuse canonical definitions; keyword text remains stored original text. Count reads have bounded independently fetched source rows and generation invalidation; three search policy selectors explicitly dispatch v6. The local source/HTTP/storage and native roundtrip regressions are recorded with exact input attribution in [READING_C27_INTEGRATION.md](READING_C27_INTEGRATION.md); they are not a complete production or 61-owner behavioral acceptance claim.

New source storage is intentionally not a qualified account-erasure owner. Its installed relation is outside the unchanged reviewedRelations registry: even with ZERO source rows, new synthetic inventory currently rejects with INVENTORY_BOUND_EXCEEDED or UNREGISTERED_OWNER_RELATION. A prior seal is stale because the relation set and relevant triggers change. With source rows it remains rejected. Thus existing no-source synthetic deletion rehearsal is also blocked after 0175; this packet has no independently reviewed owner-empty qualification and does not weaken old assertions. This is an explicit integration blocker, not completed deletion coverage. Administrative source/count dependency inventories gain precise guards, not weaker startup checks.

## Validation and remaining gates

Source storage, HTTP publication/read and native roundtrip suites have executed under C and en_US.utf8 in the current runtime lineage; source-only human-review production-mode API/PTY acceptance also passed on its exact earlier input with 0175 and no M2. The current worker CLI has separate verified-TLS evidence. These results do not establish provider approval, actual production policy setup, password-authenticated Docker CI, real-device behavior or qualified account erasure. See [READING_C27_INTEGRATION.md](READING_C27_INTEGRATION.md) for exact counts, hashes and remaining full cloud typecheck.

## Historical v2 SQL safety successor record

The following retains the original M1-v2 review findings and then-unexecuted test plan. Those timing statements describe that historical handoff, not current execution status. Current passes are limited to their named suites and are not a 61-owner behavioral proof.

Independent review of frozen v1 found two P1 SQL defects: inherited generation callbacks run inside BEFORE STATEMENT writers, so `SET CONSTRAINTS ALL IMMEDIATE` could drain the only check before a later dependency mutation; consumption also lacked the runtime's newest-exact-decision selector. v1 is retained unchanged and is not admitted. This separately versioned successor changes only 0175, tests and documentation; the request/capability/source DTOs above and reviewed pure core bytes do not change.

The repair separates construction phases. Immediately after source insertion, independently persisted source columns and the real content row reconstruct the exact decision using only its scope. Current actor/destination/ancestors, exact original intent, consumable Review, cancellation and Media are checked without demanding the not-yet-written binding, terminal receipt, report origin or outbox. Full causal completeness remains deferred. The explicit 61-relation AFTER STATEMENT dependency inventory observes post-write state even after constraints have become IMMEDIATE; zero-row statements are checked but do not by themselves invalidate current authority. TRUNCATE additionally checks complete causal closure, since it is not a publication construction step. Original generation, writer, nonblocking locks and legacy v4 fingerprint semantics remain unchanged.

Two existing relations receive nullable server-owned `xid8` columns: `content_approval_decisions.text_source_issuance_transaction` and `text_review_requests.text_source_transition_transaction`. V1–V5 remain NULL without backfill. Callers may not supply an issuance marker or change an existing queue marker. A fresh v6 queue INSERT is stamped; only an actual first decision-link transition restamps an older queue, after exact original account/request/operation/intent/decision matching. No-op updates retain their old marker. This supplies indexed current-transaction cohorts for fresh submissions, fresh publications, unqueued decisions and ordinary operator approval of older queues. The markers identify recheck work, never confer authorization. Decision issuance does not require an allow result or a head/event that is legitimately created later.

Consumption now requires the newest exact decision ordered by `evaluated_at DESC, id DESC`, without first filtering out reject/pending/headless decisions. The `consume=false` bound-visibility path is unchanged: a later independent decision is not automatic retroactive revocation of a durable publication.

The new columns and triggers additionally invalidate installation/erasure shape seals. Registering the source relation alone is insufficient: the separate deletion owner must qualify the complete 13-relation source-negative partition with independent locked zero-row enforcement and full-table comparison. Original opaque requests, rejected receipts, standalone cancellation and pending Review cannot be omitted. This packet does not implement or admit that erasure qualification, and the existing synthetic deletion gate remains blocked.

The added PG/HTTP tests are drafts only: all three cohorts under default/named/all-immediate timing; post-write space/Safety/topology/TRUNCATE invalidation; valid staged publication; savepoint rollback; zero-row no-ops; unqueued reject/pending/headless issuance; server-owned marker anti-spoofing; newest exact reject/pending/headless/tied UUID selection; raw SQL old-allow source insertion rejection; and unchanged durable visibility. Actual installed trigger and column inventory is also tested in the future PG gate. Passing pure static inventory assertions is not evidence that PostgreSQL executes these guarantees correctly.

Coverage precision: the drafted 3×3×4 timing matrix is for source-post envelopes and the four named mutations only. It is not a 61-owner behavioral test. Late child-ancestor visibility/Review withdrawal, phone Verification, account status/lifecycle, region-policy and direct request/origin/outbox changes, plus two-session races, still require genuine central tests and execution before acceptance.
