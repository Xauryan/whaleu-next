# Native ratings R1

This is a development slice for the new ratings domain. It is separate from posts, errands and historic specialist scales. Runtime catalog rows come only from the authenticated server; the client does not seed example schools, targets, scores or review approvals.

## Pages and scope

- `rating-catalog`: global root by default, explicit server-authorized region selection, one category level per navigation, and direct targets. Category and target pagination are independently bound to region, parent/category and catalog revision.
- `rating-detail`: current target, independent own score, known/unavailable distribution, newest-first root comments, text-only publication and own deletion. Returning performs fresh reads. Current server actions and known own-score history govern score controls. Explicit identity choices come only from server `authorModes`.
- `rating-recovery`: account-owned minimal recovery without context, target, phone, profile or catalog reads. The profile page provides an independent entry. Hidden targets and deleted comments cannot turn receipts into content snapshots.

The region picker is a separate read. Failure does not become an empty region list. Global directory loading does not depend on this picker. Category/context and target/score/comment phone requirements remain backend decisions; no post/errand authorization heuristic is reused. Browsing campus is never a grant. Changing browsing campus, identity-campus state or Safety clears the old view and requires a new read.

## Independent writes

Scores are strictly integers from 1 through 5. No own score is `null`; unknown history has a separate state and disables submission. Known zero-count statistics show no average. Unavailable statistics never show zero. Decoding verifies integer bounds, five nonnegative buckets, count, weighted sum and one-time rounded average.

Choosing a score opens a confirmation. A matching same-score no-op retains its original revision and historical transition time. Repeated taps cannot create extra request keys. Success/no-op receipts are historical results only: the controller separately reads current own score and summary so an old receipt cannot overwrite another device's newer change. Terminal revision conflicts require explicit refresh, reselection and confirmation. The client never automatically overwrites with the old score after refreshing.

Text does not require a score and cannot create one. Client and backend both normalize CRLF to LF and trim outer whitespace, then require 1–500 Unicode code points. TAB and LF are accepted; other C0 controls, C1 controls and lone surrogates reject. The raw UTF-16 input also has a 1,100-unit bound before canonicalization. Text is not silently truncated or Unicode-normalized. Identity mode is explicit and never silently changed. Assets must be empty. Images are labelled unavailable and have no picker/upload button. Creation only returns applied/rejected receipts, never no-op.

Anonymous comments expose only a target-bound random persona, display name, ownership and allowed actions. Each nested DTO is exact: account/profile/original-user fields, unknown actions or a persona for another target reject. Named projection contains only the safe public profile ID and name. Delete controls require server `isMine` and `allowedActions.delete`; local account comparisons never infer ownership. Deleting text does not withdraw a score. Receipts contain no body, author, score snapshot or distribution.

## Recovery and lifecycle

The three command kinds share one immutable journal per API origin and account. UUID, operation, target/comment, revisions, region, canonical body/mode and empty assets are frozen, persisted and read back before dispatch. Editable text is only in page memory; uncertain command intent remains in the original account's journal until a matching minimal terminal receipt settles it.

Timeouts, 5xx, malformed responses, missing receipts, ordinary HTTP conflicts, auth uncertainty and stopped waits preserve the same key/intent. Only explicit retry resends that identical command; lookup never implicitly retries. Storage failures prevent dispatch or retain the recovery barrier. No expiry/new-key escape exists. Ordinary HTTP errors alone never settle a journal.

Account replacement, same-account epoch changes, page/app hide, unload, cancellation, target changes, Safety and campus changes cancel callbacks and clear body, scores, summary, text, mode, deletion ID and cursors. Closing a modal during secure UUID generation prevents persistence/dispatch. After dispatch, close only stops waiting; late results cannot render or clear the journal. Foreground recovery precedes current target reads. Authorization/read failures clear dependent content. Only an exact HTTP 503 `RATING_SCORE_UNAVAILABLE` may independently downgrade own score to unknown; malformed/protocol errors cannot take this path.

## Verification boundary

`test/ratings-*.test.ts` covers strict contracts, real API-client gateway requests, frozen storage, fresh current-state reads, conflicts and interruptions. `scripts/smoke-ratings.mjs` executes emitted page JavaScript through real gateway/decoders against synthetic in-process transport. A bounded repository-owned model interprets emitted WXML conditions, loops and templates. Neither is WeChat DevTools rendering, physical-device acceptance, production scoring, PostgreSQL validation or a provider call.

Run from the repository root:

- `npm run typecheck -w @whaleu/wechat`
- `npm run test -w @whaleu/wechat`
- `npm run build -w @whaleu/wechat`
- `npx eslint apps/wechat`
- `npx prettier --check apps/wechat`

Real-AppModule HTTP/PostgreSQL acceptance is a separate backend suite. Production catalog import/maintenance and trusted review issuance remain release gates. Replies, likes, subscriptions, notifications, experience, target creation/management, media, specialist courses/canteens, other clients and real-device/provider acceptance remain unfinished. Author cumulative received-like semantics are not implemented or decided here.
