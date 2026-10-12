# Major directory and text discussion: partial local slice

Major is an independent source-backed department/college/major directory with
named discussion. It is not a numeric rating target. This slice adds a bounded
native directory, reviewed text roots, flat addressed replies, reversible CAS
likes, exact local notices and original-request recovery. Images, author/admin
soft deletion, accepted nonempty legacy history, real issuers/providers, physical
WeChat acceptance and production remain separate required work.

## Fixed source and deliberate differences

The source is [WhaleU at 57cf169c](https://github.com/WhaleUCampus/WhaleU/tree/57cf169c11123acf249909a1a7215b8cb1ec1f8e).
[Major.php](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Major.php)
17–48 groups numeric department IDs; 58–138 filters major/college names and returns
root-comment count/hot text; 150–285 exposes named discussion; 295–347 prioritizes
same-department recommendations.
[MajorComment.php](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/MajorComment.php)
17–157 lists roots and direct flat replies; 171–240 publishes; 259–375 reverses
likes; 395–462 soft deletes; 552–616 writes local reply notices.

- No source numeric score exists. Root count means visible root comments, not
  people, replies, enrollments or an average. Complete current membership heads
  select the hot root by likes, creation time and stable ID descending.
- Department numbers retain the signed int32 source domain, including zero and
  values outside Course's whitelist. Major/college keyword matching is combined
  with department filtering. Search uses literal substrings and case folding,
  never treats `%`, `_` or backslash as SQL wildcard syntax.
- Directory ordering is department number then stable Next Major UUID. Opaque
  actor/session/filter/limit-bound continuations are a Next addition; they do not
  claim numeric legacy-ID ordering. Related results exclude self, prefer the
  same department, then sort other departments deterministically. Their bounded
  recommendation limit is separate from the full available candidate count.
- The legacy hard-coded introduction, curriculum, career, degree guess and
  four-year duration are omitted. No authoritative educational facts are invented.
- Publication requires verified affiliation, temporary verified base identity or
  an actual school/super administrator role. Developer alone is not that legacy
  administrator role. The original school selection, matching institution,
  student number and chosen browsing campus are not additional requirements.
- Browsing and likes require current session, verified phone and Safety only.
  Original owned receipts, exact-key cancellation, known own-state lookup and
  reducing a known like remain possible after source/phone/Safety/base withdrawal.
- Roots and replies are named via Profile's safe public ID/display name. Review,
  both block directions, known author coverage, bounded text and exact target
  validation are explicit Next hardening. Raw account IDs and legacy avatar URLs
  are never public author data.

The legacy native app has no proven registered Major page. Next registers its own
six pages and validates fresh notice targets; it does not reuse the legacy fallback
that confused a Major ID with a generic post ID.

## Independent accepted source and history

Forward migration `0121_major_discussion.sql` creates empty `whaleu_majors` storage
plus distinct Review and Notifications records. Every earlier SQL byte is retained.
Major does not import Window/Course codecs, catalog IDs, history assertions, score
records, Review purposes, command keys or notification dedupe identity.

An immutable source identity binds source namespace, original Major key, original
school key, department number and independently accepted Campus crosswalk. Sealed
catalog entries carry original major/college names, active state and crosswalk
provenance. Current Campus/operating-region availability participates in the proof.
The old `university_id=1` is not assumed to equal any Next Campus or seeded as a
real university. The complete accepted catalog is bounded to 1,000 entries; an
explicit accepted empty catalog is valid, while missing/unknown/withdrawn/expired
catalogs are unavailable.

Catalog acceptance proves neither discussion population nor like membership.
Separate `population` and `likes` accepted-empty assertions plus new native records
are supported. Unknown/missing/expired assertions yield unavailable summaries and
membership absence, never invented zeros or false `isLiked`. There is no production
source importer, nonempty legacy-history admission, Review issuer or activation API.

Public discussion reads inspect the entire Major population up to 1,000 candidates
before pagination. Exceeding that complete-proof budget fails unavailable; it does
not truncate a count/ranking. Directory entries remain usable with an unavailable
summary when their independent discussion proof is unavailable. Roots default to hot
likes (matching the legacy detail view) and also support latest time; direct replies
sort chronologically with stable UUID ties.

## Publication, reversibility and recovery

Distinct `major.discussion.root.v1` and `major.discussion.reply.v1` Review purposes
bind exact actor, original key, catalog/Major revisions, body, root, addressed reply
and server-derived addressed actor. The client cannot supply an arbitrary recipient.
A reply parent must be a current visible root in the same Major; an addressed reply
must be current and belong to that root. Cross-Major/root or hidden targets fail.
Hidden roots suppress dependent replies. A hidden addressed reply removes its
identity and target reference from a remaining visible reply.

Exact nonblank well-formed Unicode text is preserved, limited to 8,000 UTF-8 bytes
and excluding NUL. Text `0` is accepted. These limits are Next policy, not recovered
PHP limits. Image-only and text-with-image commands are rejected in this first
slice; source text was mandatory, so Major image-only parity is not claimed.

Likes specify desired `active` and nullable `expectedMembershipRevision`. Locks
serialize original requests and absent/current actor-comment heads. CAS is checked
before equality: stale same-state requests conflict, current same-state requests
are noop. Changing transitions append immutable events and retain inactive heads.
Re-like is a new event. Original successful receipts never rewind a later state.

Native journals freeze account, origin, exact operation/key/text/targets/source
revisions/CAS, persist them and read them back before transport. Lost responses,
backgrounding, navigation, session/account/origin changes and late callbacks never
create a replacement key or optimistic success. Separate recovery is reachable
without current detail, retains minimal recent own-like references and supports
receipt lookup, exact replay/cancellation and reduced-authority unlike after cold
restart. Receipt success is historical; current data always comes from a fresh read.

## Exact local notification semantics

Major has no creator concept and roots have no creator notice or creator gate.

- Replies notify the root author, with the root as the target.
- If an addressed reply author differs from the root author and publisher, that
  author receives a second notice targeting the new reply.
- Both reply previews come from the causal new reply, not the root. Both the
  current target and causal reply must remain visible before preview/navigation.
- Each genuine false→true like transition notifies the liked item's author unless
  self. Noop, replay and unlike emit nothing. Re-like produces a new notice.
- Self and duplicate recipients are suppressed. Unlike retains historical notices.

Notifications owns immutable per-event/recipient obligations, exact private unread
counts, explicit read acknowledgments and fresh target resolution. Statement and
deferred SQL guards require the exact complete obligation set in the same mutation
transaction; forged/missing recipients and a root-author notice misdirected to the
reply roll back. Unavailable targets retain a private shell; marking read grants
no visibility. No provider, reward or generic lifetime-like effect is introduced.

## Current-proof boundary

Fixed NOWAIT owner fences, monotonic catalog/content/Review/notice epochs and mandatory
owner fingerprints (including the full current Campus mapping and catalog ABA)
protect session, phone, base identity, source, independent
history, Review, Safety and Profile. SQL checks tie strict intent, Review, flat
relations, predecessor/head, original receipt and notices together. Exact PostgreSQL
time boundaries include off-page and currently denied/future-issued rows. Native
and HTTP continuations expire/restart on relevant source/owner/profile/time changes.

Managed Database transactions flush deferred constraints, validate mandatory owners
and check exact deadlines before COMMIT. Raw transactions that force constraints
and subsequently wait are not promised a COMMIT-clock callback; statement/deferred
checks linearize when they execute. No production authority is derived from fixture
acceptance or a chosen campus.

## Typed HTTP and native surface

Bearer authenticated, strict request/response codecs, shared account request budget,
`Cache-Control: no-store` and `Vary: Authorization`:

- GET `/v1/majors/departments`, `/v1/majors`, `/v1/majors/:id`, `/:id/related`
- GET/POST `/v1/majors/:id/discussion`
- GET `/:id/discussion/:rootId` and POST `/:id/discussion/:rootId/replies`
- POST `/:id/discussion/:commentId/like`, GET `/:id/discussion/:commentId/my-like`
- GET `/v1/majors/discussion-requests/:requestId`, POST `/:requestId/cancel`
- GET `/v1/me/major-discussion/notices`, GET `/:noticeId/target`, PUT `/:noticeId/read`

Generated [OpenAPI](openapi/major-discussion.json) covers directory and discussion.
Registered pages are Major directory/detail/discussion/thread/recovery/notices.
Directory, general recovery and private updates expose these new entry points.

## Validation and required next slices

Focused source tests cover strict codecs and independent domains; directory
filtering/accepted-empty/ordering/related; isolated publication eligibility;
current Review/Safety/Profile; root/target withdrawal; exact notices; complete
counts and pagination; original-key cancellation/concurrency/response loss;
reversible membership and session-only recovery. Actual emitted App/Page/WXML and
production gateway traffic run against ordinary loopback AppModule and disposable
PostgreSQL, with only platform callbacks and explicit synthetic accepted facts
substituted. The exact executed results are recorded after validation; listed
scenarios alone are not evidence of a passing PostgreSQL/device run.

Required remaining parity includes typed text+image Media/Review, safe avatars,
author and legitimate school/super-admin soft deletion with original-school
mapping, and nonempty authoritative history/crosswalk import. Provider activation,
true native rendering/device acceptance, operational tuning and production rollout
remain separate gates. This document never marks the whole Major feature complete.
