# Native permanent-reference reader candidate

This is an additive native WeChat reader, not a web-view, HTML interpreter, Markdown editor, or production activation of the reference namespace.

## Actual migration boundary

The first consumer is the existing community-detail page. Its post text, root-preview text, reply-preview text, and located-comment text use the local `reference-text` component. All other pages retain their current presentation. The accepted Home, Messages and Me layouts are unchanged.

The component preserves exact source text and UTF-16 offsets. Only a strict, currently available capability enables bounded ASCII `#` reference tokens. URL/contact precedence, invalid lengths, leading-zero runs and preview truncation remain conservative. No source body is sent to a lookup service. The optional canonical-code lookup covers only the visible parent post in this slice, not a scan of offscreen replies.

## Authority and interaction

A reference tap is checked against the current row, source token, page generation, account and scope. The server resolves current canonical visibility and ancestry, and the destination performs its ordinary authorized read again. A returned UUID is not an access grant. Destination hints are never cached as authority.

Hide, unload, account replacement, relevant safety/private-view invalidation and browse-scope changes cancel or invalidate outstanding work. A later menu, dialog, image preview or other blocking interaction wins over an earlier tap; closing it does not replay that intent. Long-press/cancelled or stale interactions do not navigate. The two previous plain-text preview routes retain their exact parent/root/reply and optional view-space query mapping.

The renderer does not acknowledge notifications, allocate codes, change discussion cursors or send reference-generated analytics. Optional lookup failure never hides original text or invents a number. Tencent touch, accessibility, selection and device rendering acceptance remains separate from executable Node component tests.

## Evidence and pending gates

The authenticated successor guard preserves the complete V35B predecessor manifest, original page bytes, 143 unchanged raw actions and their ancestor chains. It admits exactly four reference renderers and two equivalent plain-text fallback routes; unknown hashes, controls or relocated permissions fail closed. Parser, controller, component and successor-focused tests have been executed locally. The aggregate reference candidate, build/resource budget and real PostgreSQL reference suites still require their own frozen validation window.

`content-reference-native-roundtrip.test.ts` and its emitted-JavaScript worker are authored to exercise inactive and synthetic-ready states through the actual emitted Page/component and loopback HTTP/PostgreSQL, including fresh destination reads and hide/logout fences. Authorship is not execution evidence. Neither this harness nor static previews constitutes actual WeChat device validation.

## Production and remaining product scope

Migration 0171 starts inactive. There is no production initializer or legacy importer. User-visible references must remain disabled until authoritative legacy canonical/alias inventory, UUID crosswalk, counters/cutoffs, writer fencing, resumable reconciliation, coverage, restore rehearsal and separately reviewed activation are complete. Synthetic initialization in a disposable test database is not production readiness.

Not covered here: reference rendering on every other text surface, authoring assistance, copy/share UI, legacy migration, Markdown-aware parsing, or reference-only Home classification. These remain independent work rather than implied completion from this first reader.
