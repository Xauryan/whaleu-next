# School posting policy: current administrator → ordinary publication

## Scope and legacy evidence

This owner completes the native school-administration exception for known unverified users. The old school switch reached both posting and commenting; posting was limited to nine ordinary categories and named identity. It does not grant student verification or a new school identity.

Fixed evidence (WhaleUCampus/WhaleU at `57cf169c11123acf249909a1a7215b8cb1ec1f8e`):

- [Native school management save](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/miniprogram1/pages/admin/school/index.js#L201-L230)
- [Actual unverified posting/comment consumers](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolReviewChannelService.php#L79-L100)
- [Fixed school administrator region and explicit super-administrator target](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/AdminScopeService.php#L170-L187)

The current implementation exposes separate posting and commenting controls because these already are separate fields in the canonical policy ledger. Comment permission includes replies and does not borrow the selected post-category allowlist. The nine post categories are discussion, confession, companions, pets, internships, scenery, dorms, research and deep_sea. Trading and feedback retain their own stricter owners. An empty category set permits no unverified posts, even when the post switch is on.

## Authority and single source of truth

`SchoolConfigurationAccess.management` resolves a live session, Safety state, actual grant and active operating region inside the same transaction. A school administrator has exactly its fixed grant region. A real global super-administrator must explicitly choose an active region. Developer-only grants, profile titles, selected browsing campus, and student identity do not confer this authority.

The only effective values remain `whaleu_community.region_policy_revisions` and `region_policy_heads`; `RegionalCommunityPolicyService` and runtime publication authorization consume that same ledger. Migration 0100 adds an immutable actor/grant/command/old-revision/new-revision audit and cancellation receipts, not a parallel boolean configuration source. It does not seed roles, school data or accepted legacy facts.

Save takes the existing exclusive common policy gate before identity/grant/head locks, serializes the actor/request key, compares `expectedRevision`, appends one revision, advances the same head, and records one exact receipt atomically. DB guards verify the command hash, revision values, current selected grant, target region, and atomic audit. A bounded final proof fences current grants, region and the original ledger/head after deferred work; grant/session/new-policy deadlines remain in force until commit.

Canonical identifiers are lowercase UUIDs; a request key is UUID v4. Uppercase keys/targets are rejected by this owner before hashing or PostgreSQL casting. Category order and submitted UTC timestamp spelling are exact command bytes, not silently normalized on retries.

## Availability and expiry

- No head or revision zero: `unconfigured`. GET never writes a default. Ordinary unverified publication fails closed as `COMMUNITY_UNAVAILABLE`.
- Valid complete accepted evidence: `active`. An explicit false switch is a known denial; the relevant publication receives `STUDENT_VERIFICATION_REQUIRED`.
- Valid accepted evidence past its explicit deadline: `expired`, unavailable to ordinary publication. A currently authorized administrator may explicitly publish a new CAS revision with new provenance and a new validity choice. This does not retroactively extend the expired revision.
- Unknown/conflicting/incomplete provenance, missing source references, future effectiveness, unknown expiry or unsupported/duplicate category history: `unavailable`, read-only. This page cannot silently certify it.
- Existing `related_sync_enabled=true`: read-only with a specific blocker. Related-campus synchronization has no supported command in this slice and requires a separate complete workflow. There is no decorative enable switch or implicit reset to false.

For absent or trusted false-sync history, the administrator's complete new policy explicitly establishes false synchronization as part of the supported non-sync policy. Validity is either `policy_exempt` (no automatic expiry; remains until a later explicit configuration) or `at` with a future ISO UTC `Z` timestamp. This is the original policy model; the experimental CLI's 1–168 hour restriction is not copied into school authority. Revoking the administrator later blocks new writes and management reads; it does not retroactively revoke already published settings.

Phone verification stays mandatory. Unknown or unavailable affiliation is not treated as unverified. Named-only restrictions, anonymous-parent restrictions, content Review, currentness, media rules and ordinary publish receipt handling remain unchanged. Existing verified-student behavior does not begin depending on this exception.

## HTTP and native lifecycle

- `GET /v1/me/school-posting-policy?regionId=...`: exact current management projection. Omit region only for the fixed school administrator.
- `POST /v1/me/school-posting-policy/:regionId`: exact command `{clientRequestId,expectedRevision,policy}`. Provenance and actor/grant references are generated by the server.
- `GET /v1/me/school-posting-policy/requests/:requestId`: authenticated owner's historical metadata, also after grant revocation.
- `POST /v1/me/school-posting-policy/requests/:requestId/cancel`: original request hash; serializes with save. A committed command returns its original receipt and is never undone.

The native page is reached from school service management. A fixed admin never gains a different region from browsing selection. Global selection uses a currently active campus-to-region projection and explicitly targets the resulting region. A new unconfigured form starts off with no categories and an empty explicit-expiry field; these draft defaults do not imply accepted saved configuration.

Before dispatch, an actor/environment-scoped durable journal freezes the exact target, body, CAS and key. Network loss, Back, hide, logout and delayed callbacks cannot create a fresh command. Recovery is available before current management loading, so permission loss does not hide an already submitted request. A confirmed save receipt is historical: the page clears its editor and requests a fresh current read. Revision conflicts retain the original request until it is resolved/cancelled; there is no auto-rebase or replacement request key.

Publication Review includes `configurationRevisionId` in its exact envelope. A policy revision change cannot rewrite an old digest, consume an old approval for a changed scope, or manufacture a new request key. Already-applied content and receipt recovery remain intact after the exception closes. A deterministic disabled-policy denial remains the existing original-key `rejected` receipt: native clears the confirmed pending key and retains the draft. An unavailable or changed exact Review remains unresolved until its original receipt/cancellation is established.

## Verification and operating limits

Focused API contracts/projector tests and native strict-decoder/journal/lifecycle tests cover scope, source distinctions and exact-command recovery. PostgreSQL tests cover actual original-ledger consumption, current grant/region restrictions, CAS races, cancellation races, accepted expiry renewal, immutable audit and unresolved provenance/sync blockers.

`school-posting-policy-native-roundtrip.test.ts` drives emitted App/Page/WXML through `WechatTransport`, ordinary HTTP and the real AppModule/PostgreSQL. Only platform/provider transports and initial school/admin grant facts are synthetic. It exercises native administrator save with response loss and same-key recovery, a newly logged-in phone-authorized but unverified user, exact local Review, post/comment/reply, feed/detail/search, administrator disable, exact-revision conflict/cancellation and deterministic terminal rejection of old approved requests, and retained existing content/receipts.

These are simulated acceptance tests, not real-device or production deployment evidence. Real use still needs authoritative school/role migration, approved real identity/phone providers, an operational production Review issuer, HTTPS/AppID and real WeChat/device validation. No external secrets or production records are used by this implementation or its fixtures.
