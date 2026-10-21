# Bounded discussion counts and large-thread readability

This is a separate business-correctness successor to the immutable V33C component migration checkpoint. V33C itself is unchanged.

## Reproduced defect and scope

The former serializer rejected 1,025 active roots, 1,025 replies under one root, and 513 + 512 replies across two roots with COMMUNITY_UNAVAILABLE. This could reject the containing feed page. Increasing an unbounded scan cap is not an acceptable remedy.

The API implementation now under construction uses bounded canonical visibility scanning and optional exact counts. Database, concurrency and final integration acceptance remain pending. Do not describe this document as proof the server change is complete.

## Wire and native contract

Post.commentCount/replyCount/discussionCount are either all null, or all nonnegative safe integers with a safe, exact sum. Mixed known/unknown triples, malformed values and inconsistent sums are rejected. Comment.replyCount is a nonnegative safe integer or null. A reply preview remains bounded and parent-checked even when its exact count is unavailable.

Null means only that an exact count is unavailable. It must not encode a visibility-failure reason, be coerced to zero, or make a safely readable post disappear. Existing numeric responses remain accepted. Native views show a restrained dash, with meaningful unavailable accessibility text for icon-only counters. Specialist window/major discussion contracts are unchanged.

After root deletion the local aggregate stays exact only if the prior triple and deleted descendant count are known and consistent. Otherwise all three become unknown. The client never assumes an unknown descendant count is zero.

A bounded scan can return no visible items and a non-null opaque continuation. Detail and thread pages must retain load-more in that state, reject a nonadvancing cursor, and clear stale private rows on restart-required errors. Context rows remain separate from normal traversal.

## Accepted Home layout exception

The user-approved Home layout is unchanged. Only its counter value and accessibility label expressions change to support the new nullable API contract. No tags, classes, layout styles, navigation, handlers, datasets or visibility guards change. Messages and Me remain untouched. This later business correction is an explicit exception to the V33C byte freeze, not a claim that the original snapshot changed.

Historical migration baseline fixtures are not to be overwritten. Subsequent integration must preserve exact V33C source evidence and verify each narrow successor against focused behavior and unchanged action/layout structure before accepting new protected-file hashes.

## Observed client validation

The strict decoder, local deletion and empty-scan/restart controller regressions passed with the existing community contract, discussion read and pagination suites: 45 tests, zero skipped. Scoped production/dependency/test typechecking passed. Final backend/full-suite/release and physical-device acceptance are separate gates.

## Protected-source lineage

The unchanged historical framework migration inventories now pass through `test/reviewed-business-successor.ts` only for six explicit later-business paths. For each, `business-successor-v33c.json` retains the V33C original hash, copied original source bytes and exact reviewed successor hash. All unknown paths/hashes still execute their original guards. No old baseline JSON is regenerated. One successor is the separate timetable three-route registration; the other five support nullable discussion counts. The Home test reconstructs its exact allowed two-expression substitution and compares the complete file, proving no layout, class, handler or navigation change. This explicit successor is distinct from claiming old bytes remain identical.
