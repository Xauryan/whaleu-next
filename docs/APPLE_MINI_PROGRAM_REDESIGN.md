# Native mini-program redesign

## Scope and source

This native redesign increment starts from `9c0041f0be3a8414d02ecb0bfc5c76409480c3b3`
on `rewrite/backend-foundation`. It preserves the existing TypeScript/NestJS business foundation and adds a scoped
Following backend/native contract. It does not activate providers, migrate
production records, or authorize deployment.
No Vant/TDesign components or proprietary Apple assets are used.

The design uses system typography, semantic light/dark surfaces, restrained
spacing and rounded controls, thin separators and a translucent bottom bar.
The four destinations are Home, Campus, Messages and Me. The middle plus is an
action: it pushes a compose flow without replacing the current destination.
Root navigation replaces the stack so repeated destination changes do not exhaust
the mini-program page limit. Navigation is single-flight and failures are visible.

Home is the entry page; login remains an explicit destination. Existing controllers,
gateways, request journals, content authorization, privacy and recovery remain the
business authority. Hidden Following/global states must not record feed exposure.
Campus means the chosen actual school/campus, not a hardcoded Beihang label.
Intercampus lists server-provided global communities, and does not reinterpret
related-campus synchronized content as one combined feed.

Me is a profile-first page: real identity/avatar and public named posts, with
private saved/liked tabs and settings in a secondary menu. Anonymous publication
history remains a separate private destination. No social metrics are invented.
Home uses two independent content columns from actual posts, with exposure IDs
preserved and metadata/actions available in secondary menus. Authenticated image
thumbnails are read only for visible cards, at most three resident images and
serial feed download admission; width-preserving native rendering never promotes
a thumbnail cache into an expanded viewer. Missing download acceptance remains
an explicit unavailable state, not a public-image URL fallback. Promotional hero
panels and introductory marketing cards are deliberately excluded.

## Honest capability boundaries

- Following now uses the authenticated, named-public-author Following contract,
  scoped to the selected community. It never substitutes recommendations or campus
  pins. Public-profile actions persist unknown intentions per account and require
  explicit same-request retries; acknowledgements are followed by a current-state
  read. Missing runtime, guest, empty and unavailable states remain explicit.
  This is local/synthetic validation, not live activation or device acceptance.
  See `FOLLOWING_NATIVE.md` for boundaries and recovery evidence.
- Personal timetable is missing. Grades need an authorized real academic provider.
- Tool links resolve actual catalog IDs; they must not manufacture map/bus/research
  routes with missing scoped identifiers.
- Message badges retain their source scope. An unknown count is not zero, and the
  new shell does not mark messages as read or combine unrelated badge counts.
- Existing development/provider notices remain accurate. Synthetic data used by
  tests or visual previews never becomes runtime fallback content.
- Native WeChat DevTools, real-device safe-area/keyboard/accessibility and live
  provider acceptance remain release gates. A browser rendering of WXML/WXSS is
  a layout approximation, not proof of native behavior.

## Visual inspection

After `npm run build -w @whaleu/wechat`, run:

`node apps/wechat/scripts/preview-apple.mjs`

The ignored `apps/wechat/preview` folder contains source-derived HTML approximations.
These show empty/initial states, a labeled sample campus context, and a separate
explicitly fictional populated profile fixture for design review. The fixture never
enters runtime source or represents an operational backend. Source-only generation
can use `node --import tsx apps/wechat/scripts/preview-apple.mjs --source`. Real-device QA must additionally cover dark mode,
font enlargement, safe-area devices, keyboard, back navigation, rapid tab changes,
account/campus changes, cancelled/late requests and recovery of unknown mutations.

## Newly identified legacy parity backlog

The previous legacy audit reference `57cf169c` is not an exhaustive current parity
baseline. Legacy `WhaleUCampus/WhaleU` head
`4494e36b9451e3a92874ccf85f574a36e28e3d48` is 220 commits newer. This shell is not
completion of the rewrite. Audit and port semantics into TS rather than copying PHP:

1. **Account deletion (P0):** seven-day cooling period, cancellation only by explicit
   interaction, 30-day re-registration restriction measured from completed cleanup;
   eligibility, erasure/shared-media ownership and session-race tests.
2. **Long-form and Markdown:** explicit-only Markdown with editable preview and
   inline images; default-on/opt-out plain-text formatting for posts >=300 and
   comments/replies >=200; immutable source hash, asynchronous formatting, safe
   fallback; no additional AI formatting for Markdown.
3. **Permanent content references:** comments/replies, 7/8/9-digit aliases,
   non-reuse, ancestor visibility and Markdown exclusions.
4. **Home distribution policy:** <=3-character/reference-only posts use author-only
   Home distribution plus water category 9, not a content-visibility change;
   exclude pushes/sync while retaining documented accessory exemptions.
5. **Profile replies and notification receipts:** private reply visibility;
   actual viewport/dwell receipts with snapshot cursor, never mark all read merely
   because a post was opened.
6. **Deletion provenance and pinned discussion:** distinguish admin/report/self/
   unknown sources, restore invalidates prior evidence; scoped main-comment pin
   authorization.

Primary legacy services: `AccountDeletionService`, `ContentReadingFormatService`,
`ContentReferenceService`, `HomeFeedPolicy`, `ProfileRepliesService`,
`NotificationReadService`, `DeletedContentSourceService` under `treehole/app/service`.
The earlier broad parity statement in `FEATURE_PARITY.md` must not be used as
acceptance of these additions. Each needs its own contract, permission tests,
recovery behavior, client flow and release evidence before claiming parity.

## Native packaging gate

The development build is not an upload-ready release package. The October 20
inspection measured 1,427 emitted files / 111 pages and 5,968,094 uncompressed
bytes. A local ESBuild minification experiment (JavaScript, WXSS, JSON; no WXML
rewrites) measured 4,178,869 bytes. These are local filesystem measurements, not
WeChat's authoritative upload accounting or an observed platform rejection.

Moving page folders alone is insufficient: the root App eagerly imports shared
business runtimes. A dependency-aware main/subpackage build is required, retaining
main destinations and common controllers in the main package, duplicating only
needed private modules/assets inside feature packages, and preserving existing
deep links. With the measured main closure and an earlier three-palette icon subset, the initial main estimate was 1,876,152 bytes;
new Following and profile-first changes require remeasurement. Unused icon tone
variants and authoring SVG/contact sheets must not inflate the release package.
Current platform limits and native load/navigation acceptance must be verified
before claiming a release artifact. Production activation remains out of scope.

## Separate release artifact

`npm run build:release -w @whaleu/wechat` packages a completed `dist` snapshot
into ignored `release/miniprogram`, with its own `project.config.json` and
`package-report.json`. It preserves existing deep links using generated minimal main
redirect pages, partitions deep destinations into two dependency-aware packages,
minifies JavaScript and compacts WXSS whitespace (without syntax or identifier
minification), and retains exactly referenced icon variants. WXSS regression tests
retain rpx, calc spacing, env safe areas, custom properties, theme rules and quoted
text; this remains subject to native compiler verification. Source and
development output are unchanged. Graph, asset, alias-query and byte-budget tests
are local checks; native compile/navigation and platform size acceptance remain
mandatory. Rebuild and rerun packaging after any source change.

The release packager also attempts PNG recompression for retained original icon
assets. It accepts a smaller encoding only after verifying exact decoded width,
height, channel count and every RGBA byte; otherwise it retains the original.
It does not resize, quantize away colors, redraw icons or transform user media.
The first 17-page continuation checkpoint independently verified all 136 retained
icons: 94 had smaller pixel-identical encodings, saving 9,634 bytes. Its local main
package measured 2,089,477 bytes, leaving only 7,675 bytes below the local 2 MiB
gate; subsequent batches must remeasure rather than treating this as headroom
for an unmeasured release. This is not Tencent's compiled/upload measurement.

The subsequent 33-page checkpoint (v15, excluding later discovery/auth work)
measured main 2,094,508 bytes, ratings 760,789 bytes and features 1,342,591 bytes.
At that checkpoint, only 2,644 bytes remained below the local main-package gate. Major discussion pages,
including recovery, now share the ratings package while original URLs retain
redirect aliases; stateful JavaScript modules are not duplicated. Exact indexed
PNG encoding is allowed only for at most 256 distinct RGBA values, without color
quantization, and is accepted only after decoded pixel equality verification.
All 148 retained icons passed independent pixel and dimension comparison.

The v20 frozen checkpoint (65 continuation pages, excluding later personal,
notification and management batches) adds package-local copies of the verified
stateless raster icon component only. All ordinary JavaScript ownership remains
single-owner. Its measured main package is 2,054,679 bytes (42,473 bytes headroom),
ratings 809,701 bytes and features 1,587,320 bytes. A fail-closed component and
WXML grammar gate rejects stateful behavior, missing/default-altered properties,
native actions and undeclared bindings; every copied raster retains exact pixels.
This does not authorize generic module duplication or replace native compilation.
The final integrated source must be measured again.

## Profile details and conversation-list refinement

The personal profile now reads the actual school UID, separately from campus
identity, and exposes editor/scan/share actions in the upper-right toolbar. Region,
gender and manually entered age are optional with independent private-by-default
visibility flags; the public endpoint returns only opted-in fields. Sharing uses a
fixed non-personal image instead of a screenshot that could expose private tabs.
Scanner results accept only strict known WhaleU content/profile selectors and
require explicit navigation confirmation. Real-device scanner/share acceptance is
still pending.

Messages uses the same row anatomy for human conversations and notification
senders. Owner-specific counts are not summed or acknowledged merely by opening
the hub. The three social notification categories above the list are distinct from
system/activity conversations. There is no complete incoming follower, received
save or @mention notification contract yet; an unavailable category must not be
substituted with the current user's own saved/liked collection or Following feed.

Profile content now uses the same authenticated viewport-only thumbnail lifecycle
as Home, with private tab separation and stable aspect-ratio boxes. No public
identity is inferred from anonymous owner history. Social statistics must use a
verified server aggregate; unavailable values remain unknown rather than zero.

User-provided current light/dark screenshots now supersede the earlier public
2022 tutorial reference. Only geometry and color relationships are used; personal
messages, identifiers, birth dates and third-party images must never enter source
or preview fixtures. Native visual acceptance is still needed before claiming
exact layout parity. The text-only bottom destinations and distinct red compose
action follow those references, while top spacing reserves actual WeChat capsule
and status geometry rather than copying Android device chrome.

## Profile cover, history and availability boundaries

The profile cover is a separately authorized `profile-cover-v1` asset, not an
avatar alias. User selection, upload, explicit public save, replacement and clear
use their own revision and recoverable command receipts. Read paths re-prove
current visibility and use the shared bounded temporary-file ledger. The default
trusted media runtime is unavailable: implementing these controls does not enable
production uploads. PostgreSQL migration and full media lifecycle integration
must still be executed in a disposable supported test database.

The three profile shortcuts are Browsing History, Campus Verification and Wallet.
Browsing history records actual detail viewport exposure on this account/device,
not feed impressions or fetched-but-unseen posts. It retains only bounded opaque
post identifiers, re-fetches current authorized content for display, and clears on
logout/account replacement. It is not cross-device history or encrypted storage.
Wallet intentionally exposes no balance, payment, withdrawal or substitute points
until a genuine finance contract exists. Errands and growth remain in the menu.

The review gallery's geometric cover is original, synthetic and preview-only.
Its image renderer admits only the exact locally generated fixture; it does not
copy native temporary paths, remote URLs or the user's reference artwork.

## Inbox event classification

Inbox no longer exposes backend business domains as conversation senders. Real
community/rating/dining/major social events feed the appropriate social category;
moderation, errand status, verification and authorized feedback events share the
System Messages timeline. Events retain source-prefixed keys, independent cursor
or page ownership, per-source authorization and explicit per-event read receipts.
No aggregate unread total is inferred from incomplete or overlapping coverage.
Absent activity events produce no placeholder sender. Optional source failures
are available in message status; failure of an explicit user action is visible
immediately. Session rotation preserves valid rows, while account changes and
relevant safety invalidation clear the combined projection before owner callbacks.

Current visible vocabulary uses 帖子 as the umbrella, 主题 for main content,
回复 for replies, and 分身 for pseudonymous identity. Internal schema identifiers
and identity/isolation semantics are unchanged.

## October 20 core-page and settings checkpoint

Only Home, Messages and Me were explicitly accepted visually. Subsequent Campus,
composition, topic/reply detail, profile editor, menu and settings revisions are
still review candidates, not overall design acceptance. The editor contains profile
fields only. Me's left menu uses the verified official reference's narrow drawer
geometry, with separate scan/help/settings controls; system preferences now have
their own route and reuse the existing authenticated Profile CAS controller. More
services retains prior account/admin destinations, whose route owners still enforce
authorization. No real user screenshot content is included in fixtures.

The historical v12 local measurement was main 2,088,414 bytes, ratings 619,275
bytes and features 1,325,572 bytes; total 4,033,261 bytes. Later checkpoint values
are recorded above and every subsequent change requires a fresh measurement. This is
not Tencent compiled/upload size. Real PostgreSQL integration and native device
acceptance remain unexecuted; signing/push/deployment remain outstanding.
