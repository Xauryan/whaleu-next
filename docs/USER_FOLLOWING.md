# Named-profile following

Following people is independent of saving/subscribing to individual posts. Migration `0160_user_follows.sql` adds the edge set, per-viewer cursor epoch and immutable request acknowledgements.

## API

- `GET /v1/profiles/:profileId/follow` returns `{ profileId, following }` for a currently accessible public profile.
- `POST /v1/profiles/:profileId/follow` follows the profile; `DELETE` withdraws. Both require `{ requestId: UUID }` and return a persisted receipt `{ requestId, profileId, following, outcome: "applied" }` or `{ requestId, profileId, following, outcome: "rejected", code }`.
- `GET /v1/community/following/posts` accepts the existing community feed query (`spaceId`, optional category/subtype/cursor, bounded limit) and returns the existing feed response. Login is mandatory, including the first page.

Only public profile IDs are accepted. Internal account IDs are not returned. Self-follow is rejected. A repeated request ID must identify the same target and desired state. An old successful receipt is historical and never reapplies an old intent after a newer reversal; clients should refresh current status after an acknowledgement. Known policy rejections are terminal only when a matching persisted receipt is returned. The allowlisted codes are `POST_NOT_FOUND`, `FOLLOW_SELF_NOT_ALLOWED`, `SAFETY_ACTION_RESTRICTED` and `SAFETY_ACCESS_SUSPENDED`. The client may settle that exact pending request without optimistically changing follow state. Unknown, unavailable, transport or SQL failures never become terminal receipts. The native gateway does not automatically replay mutations after authentication failure. Keep a pending intent's original request ID for manual recovery.

## Privacy and concurrency

The feed reuses the canonical community feed's content, school/distribution, moderation, category and ownership checks. It selects only named posts from followed accounts and applies current active-account, hidden-profile and both-direction named-block checks before serialization. Anonymous activity is neither included nor used to label an author.

An actor-scoped transaction advisory lock serializes edge changes (including absent edges). Reads retain a shared lock while evaluating the edge set. Changes advance a cursor epoch atomically with the edge and receipt; cursor scopes also retain the existing viewer/session, distribution and category bindings. Pagination uses the last visible post, never a filtered anonymous row. Visibility is evaluated anew for every page.

Unfollowing is protective cleanup and does not require the target still to be visible or its profile still to exist. Edges retain the public reference for withdrawal and cascade on hard account deletion. There is no follow notification, provider call, follower-count exposure or new public list of followers.

## Validation

Unit coverage: API receipt replay/idempotency, self/inaccessible/inactive/private targets, erased-profile withdrawal, actual FeedService filtering and pagination, session/epoch scoping; native strict decoding, named-only feed, target matching and no mutation auto-replay.

`apps/api/test/integration/following.test.ts` uses the real AppModule, canonical runtime fixtures and disposable PostgreSQL for HTTP auth, concurrent duplicate requests, named-only results, privacy controls and current block/account state. Run serially with `TEST_DATABASE_URL` pointing to a disposable loopback `whaleu_test` database on the project's supported PostgreSQL version. The suite deliberately refuses an existing WhaleU schema. It has not been executed in this environment, which has no PostgreSQL server/client, Docker or test database URL.
