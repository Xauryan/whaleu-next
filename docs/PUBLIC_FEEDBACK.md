# Public feedback

This is the original public, whole-site opinions/suggestions topic, not a private
support ticket. The implementation reuses Community posts, exact publication
receipts, Review, the existing nine-image Media batch owner, personas, discussions,
likes, Saved, blocks and reports. Real WeChat subscription/official-account delivery
and ordinary-runtime Media provider activation remain unavailable; neither is
claimed by the local simulation.

## Provenance

Business source: `WhaleUCampus/WhaleU@57cf169c11123acf249909a1a7215b8cb1ec1f8e`:

- `miniprogram1/packageShare/pages/yijian/yijian.js:31–46,110–123`: choose 102,
  no browsing-school parameter, ordinary post detail.
- `miniprogram1/packageShare/pages/yijianpub/yijianpub.js:107–119,328–363`:
  actual submission carries text, zero to nine images, named/persona mode and
  optional WeChat/QQ/phone fields. It does not submit a poll.
- `treehole/app/controller/Message.php:1454–1456,4844–4858`: whole-site
  scope, retaining the author's certified institution display.
- `treehole/app/service/MiniProgramSubscribeMessageService.php:633–723`:
  only real super administrators with provider opt-in/available quota qualify
  for external delivery. `NotifyWorker.php:40–75` also handles official-account
  delivery. This increment supplies local notices only and never invents opt-in.

## Explicit topic and publication

Migration `0097_public_feedback.sql` creates an empty immutable `feedback_topic`
binding. No space, role, account or verification is seeded. `GET
/v1/community/feedback/topic` resolves the accepted binding without a browsing
campus; absence fails closed. The native feedback page loads that space with
`category=feedback`, independently of the browse-campus preference.

`publish_post` accepts a strict `feedback` category and feedback definition:
`{contacts:{wechat,qq,phone}}`. All contact fields may be empty. Existing normalized
Community text/50-byte contact limits apply, zero to nine image IDs retain order,
and duplicate IDs fail. Feedback disallows polls/formations, trading definitions,
restricted comments and anonymous-DM opt-in. These unsupported options are not
silently removed. Phone, affiliation, identity selection and Safety requirements
remain authoritative. Both named and anonymous verified authors are supported;
this does not broaden unverified global publishing.

Only feedback posts use exact content envelope v3. Old v1/v2 canonical bytes,
intent ordering, receipt formats and replay semantics are unchanged. Every new
contact field and image digest is included in the original intent/Review snapshot.
Stored definition reconstruction, binding and SQL guards cover the same v3 facts.
Contacts cannot be added to a previously reviewed post. A dedicated binding guard
requires the exact accepted topic and an original-transaction reviewed publication.

## Local Review

Keep the existing explicit non-production `COMMUNITY_TEXT_REVIEW=local_manual`
configuration (regional scope, policy ID and OS operator). Additionally set
`COMMUNITY_FEEDBACK_SPACE_ID` to an existing active global space and explicitly
run `review:text` with `{"command":"init-feedback","basis":"..."}` as that
configured OS operator. The existing init-policy/show/decide/withdraw/expire/list
commands cover the topic as well as the original regional text scope.

Only the exact additional feedback space/category gains named/anonymous and
Media-backed review support. Other global spaces stay unavailable in this workflow;
the regional workflow remains named plain text. A Media review submission resolves
owned ready assets through the existing Media owner and exact ordered digests;
it never fabricates image readiness. Queue limits remain 32 active and 128 daily,
with seven-day expiry and the original same-key cancellation/consumption fence.

Approval does not publish. Native clients preserve the full frozen intent across
page close, restart, retry and uncertain responses, then require explicit same-key
publication. Optional contacts and their display consent survive draft recovery.
Changing a contact clears its native consent checkbox. Contacts can identify an
anonymous author, and the compose screen says so before submission.

## Reading and notifications

Ordinary detail and interaction endpoints retain all current Review/Safety checks.
Public DTOs include only the captured affiliation's institution display name and
whether contacts exist; there is no private account ID, phone assertion or student
number in an anonymous projection. Contacts are fetched only from the dedicated
current-authenticated-post-access endpoint, never from feed/search DTOs or profile
preferences. Native contact reveal/copy uses the existing contact controller's
fresh-read and lifecycle invalidation machinery.

Fresh feedback publication appends same-transaction local notices only to current,
active, genuinely global `super_admin` grants. `developer` or `school_admin` alone
never qualifies. A 1025th recipient sentinel fails closed rather than silently
truncating the 1024-recipient budget. Original post/recipient uniqueness prevents
replayed publication from creating duplicate notices. The outer Safety writer gate
is acquired before actor and recipient locks, avoiding opposite-admin fan-out lock
ordering. SQL retains the publication transaction, exact binding and grant anchor.

`/v1/me/feedback-notices` lists metadata without original body, author or a historical
post locator. Exact target and single-notice read operations recheck current
super-admin authority and current Community access. The native page never marks a
notice read just by listing it; explicit actions and ordinary detail navigation
are owner/session/lifecycle-bound. No external-provider message is sent.

## Validation boundary

Focused API/native contract tests cover category constraints, original hash
compatibility, optional-contact consent/draft/pending preservation, current topic
binding, scope/identity requirements, notice privacy, authority and lifecycle.
`apps/api/test/integration/community-feedback.test.ts` uses a fresh loopback
PostgreSQL 18.6 cluster, real migrations, actual native controllers/HTTP gateways,
normal publication/Review/Identity/Safety owners and explicitly injected synthetic
Media storage/reviewer. Its inputs are synthetic; it is not device/provider or
production migration acceptance. Actual validation results are recorded with the
frozen delivery rather than inferred from the presence of this test.
