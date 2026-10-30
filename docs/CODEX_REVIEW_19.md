# PassSystem verification review 19

Reviewed **3ad9f1d..ee913bf**, including **0592235** (owner requests), **247eaea** (R18 fixes), and the later deployment-record commit **ee913bf**, on `claude/passsystem-implementation-h1i74q` ([PR #1](https://github.com/aleksacavic/PassSystem/pull/1)). **Both R18 findings are fixed in their reported schedules. No major blocker established; two Low follow-ups below.**

Only this report is committed. Application source, tracked tests, migrations and Edge Functions were not changed. No production service or production secrets were accessed. No Expo, React Native, separate server or Docker infrastructure was introduced or changed. The repository records frontend `247eaea`, deployment `dpl_65HZEfC6GiZuJ3cwius6q3E1G3oQ`; live deployment status was not independently queried.

## R18 findings - fixed? yes / no / partly

| Finding | Fixed? | Evidence |
| --- | --- | --- |
| R18-01 — a counted Lord Howe period disappears | **yes** | The original three-timestamp schedule now returns 01:00/02:00/03:00, one each, with sum(counts) == total. Counted keys absent from the UTC walk are added from sample timestamps, then sorted. The six-zone/four-span count/order/uniqueness guard passes too. |
| R18-02 — successful reads slower than the poll interval never render | **yes** | The shared hook accepts a matching-query success newer than the last applied success and skips polling while the latest tracked matching request is pending. The submitted real-polling 16s/15s test displays data after 16s without accumulating a poll every interval. Error settlement ordering is a separate defect in R19-01. |

The history chart's maximum also uses a loop rather than spreading its bucket array. The fix guarantees counted periods are retained; it does not make the UTC walk a complete enumerator of *empty* shortened local periods. An uncounted 30-minute DST period can still be absent rather than represented by zero. That narrower presentation limitation does not reopen the original lost-count finding.

## Findings

### R19-01 — Low — A newer list error does not fence older completions

**Location:** `src/lib/usePagedList.ts:30`–`38`, especially the catch at line 38.

Success advances `applied.current`; an accepted error sets the message but does not advance it. Consequently the stated shared ordering rule is not applied consistently to both response outcomes.

**Concrete reproduction, real hook with deferred promises:**

1. Begin request 1 for query Q. Invoke `reload()` before it settles, starting request 2 for Q. This overlap can occur when a mutation completion explicitly reloads a list already being fetched; skipped polling does not prevent explicit reloads.
2. Reject request 2 with “new failure”. The hook displays that error, but its applied sequence remains unchanged.
3. Resolve request 1 with old rows. It passes `request > applied.current`, applies those rows and clears the newer failure.

A second probe rejects request 1 instead; its older error replaces “new failure”. Both schedules were reproduced. No filter mismatch is needed.

**Suggested fix:** when a current error is accepted, advance the same settled/applied sequence before setting the error. Preserve previously displayed data if desired, but prevent an earlier request from overwriting the newer outcome. Test newer failure → older success, newer failure → older failure, and newer success → older failure, including explicit reload during an in-flight read.

**Impact:** stale list/error presentation in Registrations and Scan activity, not a wrong-event mutation or authorization bypass. The original slow-poll starvation schedule remains fixed.

### R19-02 — Low — An open auto-aligned menu can leave the viewport after orientation/width changes

**Location:** `src/components/ui/Menu.tsx:29`–`36`.

The layout effect recalculates the side only when `open` or `align` changes. It does not respond to a viewport resize or the responsive grid moving its trigger.

**Concrete reproduction, real Menu running in Chromium in an isolated responsive-card fixture:**

1. At **844px** width, open the first card's menu in a two-column grid. Its trigger is on the viewport's left half, so it opens toward the right and fits.
2. Keep it open and resize to **390px**, where the grid becomes one column and the trigger moves toward the right edge.
3. The side remains unchanged. The LTR fixture's menu spans **x=330..538** in a 390px viewport. In the paired Arabic/RTL fixture it spans **x=-148..60**. Parts of the menu are off-screen.
4. Close/reopen: alignment recomputes and it fits again in both directions.

This probe uses the actual React Menu and current CSS/fonts, with a responsive card fixture; it is not a full EventsPage route E2E run. The missing resize dependency is in the component itself.

**Suggested fix:** recalculate while open on viewport/trigger layout changes, using cleaned-up resize/ResizeObserver handlers; measure/clamp the menu rectangle if necessary. Closing on resize is also a simple acceptable policy. Cover an open landscape two-column → portrait one-column transition in both directions, rather than only initial open at each size.

**Impact:** menu usability after a resize/orientation change. Reopening is a workaround; no archive/restore operation occurs automatically.

## Scan activity query assessment

**Embedded search and counts work against the local database.** The new integration file imports the actual `listScanActivity` implementation and passed all four tests. It checks all four scans including an unknown pass, attendee embedding, name/email search, multiword matching, a deliberately nonmatching cross-person two-word query, result+search, paging and a zero-row outsider read.

- Without usable search terms, the left embed retains unknown/invalid scans and produces `registration: null` when no readable registration exists. With terms, `registrations!inner` excludes root log rows without a matching readable registration. The tested `referencedTable: 'registrations'` filters correctly address this embed in the current PostgREST/Supabase stack, despite the output alias being `registration`.
- Each word adds an OR across first name, last name, email and phone; the separate word groups are ANDed. The `ana marley` fixture returns zero, while `bob marley` matches one, so this is not merely the final word replacing earlier terms. At most four sanitized words are used, as specified.
- `count: 'exact'` counts filtered root log rows before the range. The registration relationship is many-to-one, so it does not multiply a log into several roots. Local tests confirm both searched totals and paged totals; the range test returns one row on the second page while total remains four. Counts are for one query's authorized matching data, not a transactionally frozen history across multiple page visits.
- A supplementary real-local-API fixture assigns an operator to the target event and an organizer to a distinct event, then verifies both searched and unsearched calls return **`{ rows: [], total: 0 }`**. This extends the submitted outsider test, whose user is actually unassigned rather than assigned to another event. Assigned organizer reads the fixtures; the unchanged organizer helper also includes administrators. Operator access to scanning does not imply SELECT access to logs/attendees. The root and embedded tables each retain their existing RLS; joining does not bypass it.
- Wrong-event/removed-registration logs may have no readable attendee. They remain in an unsearched list with the UI fallback and are excluded by attendee search. This is consistent with RLS, not a join error. The new path introduces no service-role client or database grant.

**Search safety:** the filter structure, columns and relationship name are fixed. Each term is inserted inside a quoted ILIKE pattern after removing `%`, `_`, backslash, double quote, parentheses, comma, colon and `*`; whitespace separates terms. A user cannot close that quoted value or add an OR/filter node through those delimiters. Apostrophes, ordinary email punctuation and Unicode are data here, not interpolated SQL. Supabase constructs/encodes the query parameters, and RLS still applies. No filter-syntax injection path was identified in this construction; this is a scoped source/query review, not a claim that arbitrary application inputs were exhaustively fuzzed.

Sanitization strips rather than literally searches those reserved characters. A punctuation-only input can sanitize to no terms, causing the unsearched left-join behavior; it is not a wildcard search or a privilege escalation. More than four words are intentionally ignored after the fourth.

**Large-event cost:** each visible list load requests 50 rows plus an exact filtered count, and a search adds a registration join with up to four groups of leading-wildcard ILIKE checks. Paging bounds returned data, not count/filter work. Exact counts, substring matching and deep offsets can become expensive as logs grow; this review did not benchmark a large scan-log dataset or promise a production query plan. R18's poll suppression reduces overlapping reads under latency but does not make them cheaper. At larger scale, measure the actual query plan/load and consider indexed search, cursor pagination and a deliberate count-refresh budget. The full admitted-history chart remains separately loaded on open/Refresh; it is not re-fetched on every list poll.

## Shared loader schedules

The current callers memoize their fetch functions and identify `[debounced search, result/status, page]` using primitive JSON tuples. Event ownership remains enforced by keyed event/tab instances.

| Schedule | Assessment |
| --- | --- |
| Query changes while an old read is slow | Responses and errors require query equality. Old different-query work cannot set the new list. An extra hook probe rejects A after B's fresh success; B and its empty error remain. |
| Page 1 → 2 → 1, first read finishes last | Submitted test preserves the newer page-1 response; request ordering prevents the older same-query success from replacing it. |
| Same-query slow poll | A successful read may now render even if another matching request has started, provided no newer success was applied. Ordinary polls skip while the latest tracked matching read is pending, solving the original starvation. |
| Explicit reload / dismissed dialog | Stable `reload()` calls the current loader ref; the submitted old-callback test passes. It intentionally starts a read even if another is pending. Error settlement for such overlaps is R19-01. |
| Visibility polling | Existing `usePolling` skips hidden ticks and calls the latest callback on return. Return also respects the matching in-flight suppression; it does not force a second read just because the page became visible. |
| Request never settles | No timeout/abort was added. Poll suppression can wait indefinitely behind a never-settling fetch until an explicit reload/query change. This is a network-recovery limitation, not the repaired successful-16s-response schedule. |
| Unmount / event switch | Poll interval and visibility listener clean up. In-flight promises are not aborted and the hook has no explicit mounted flag; discarded-instance state setters cannot overwrite the replacement keyed event. A retained old reload callback can still issue a read for that discarded instance; no navigation or cross-event UI side effect was found. |

The hook retains prior data while a new query loads and on errors. It does not reset rows immediately or implement a new loading placeholder; those existing presentation semantics should not be described as instantaneous replacement with fresh query data. The caller's page/filter state can update before new data arrives. Only the settled matching result is accepted.

## Menu, labels and scanner controls

- In an isolated **real React Menu** browser probe, initial auto-alignment fits at 844px and reopened 390px in both paired language/direction modes. At 240px, a reopened menu with the current short action labels spans x=16..224 and fits. This is evidence for those measured placements, not a universal geometric proof: the heuristic chooses a side using the trigger's half of the viewport, rather than measuring all available menu space.
- The auto effect is RTL-aware, and compiled start/end positioning was tested with both language and direction set. The resize defect is R19-02. The archived event's menu is now in the same title-row DOM container, and archived cards still omit Scan/Share. Archive/restore confirmation and conditional status writes are unchanged.
- **Bottom edge:** no vertical flip, viewport-height clamp or internal max-height was added. A near-bottom fixture opens below the viewport (menu bottom 547px in a 480px-high viewport); page scrolling is needed. This is an existing vertical-placement limitation, distinct from the new horizontal alignment. No fixed-footer/full-application reachability guarantee was established by that fixture.
- **Keyboard/focus:** the trigger and native action buttons support Enter/Tab, and Escape closes the menu. Browser probing focuses the first action via Tab. Pressing Escape from it removes that action and leaves focus on BODY rather than returning it to the trigger. This is inherited behavior, not introduced by the alignment diff; restoring trigger focus is a worthwhile accessibility follow-up. No arrow-key/roving-menu implementation was added, and no real screen reader was run.
- “Registrations” changes only the tab label; `?tab=attendees` remains valid. Scan activity no longer says Last 100 and uses an exact matching total plus page controls; no access-control change accompanies the rename.
- Scanner control overrides reduce padding/font size and allow labels to wrap. The supplied Pixel 7 overflow assertion is relevant, but was not independently repeated against the complete scanner/camera route here. The camera hook/admission logic is outside this diff and unchanged.

## Independent validation and sensitivity

| Check | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Full unit/component suite | **175/175 passed**, 32 files |
| Integration against existing local Supabase | **142/142 passed**, 16 files, including the actual scan-search API tests |
| Extra shared-loader probes | **3 passed**: two reproduce R19-01 and one checks different-query error suppression. Reproduction probes assert the defect, not a fix. |
| Extra local scan/API fixtures | **5 passed**, including the four submitted controls and the additional assigned-operator/other-event-organizer read check |
| Browser Menu probe | Real component bundled into an ignored offline fixture; current production CSS/self-hosted fonts, Chromium, LTR/RTL, resize, narrow screen, bottom edge, Tab and Escape; no server started |
| Production build / bundle-secret scan | Passed using placeholder public configuration; 19 generated files checked |
| Full browser E2E | **Not independently rerun** under the no-separate-server constraint. Supplied **11/11** and CI remain author-reported evidence. The isolated Menu check is not a substitute for full workflow E2E. |

For R18-01 sensitivity, literal **0592235** bucketing code with current tests yielded **1 failed / 8 passed**: the Lord Howe reproduction failed; the six-zone/four-span matrix passed on both versions and is an invariant control, not independent evidence that it detects the original defect.

For the newly extracted loader, there is no literal pre-fix `usePagedList` module to restore. An explicitly **M (old-policy) variant** in an ignored snapshot reinstated latest-started-only success acceptance and removed the in-flight poll skip; the current three hook tests yielded **1 failed / 2 passed**, with the slow-response case failing. This is sensitivity to the old policy, not a claim that a missing-module/import failure reproduces the historical component. The original literal-component starvation reproduction remains recorded in review 18.

Fixtures are ignored under `tests/.artifacts/review19/` and `/tmp/passsystem-review19-before`. The supplementary Menu bundle and data use local test artifacts only. Standard integration setup temporarily changes local test limits and restores defaults; production was untouched.

## Readiness

**Reasonable to deploy/use for the intended supervised event after a real-device venue rehearsal. No new major blocker established.** The requested scan search/count/pagination behaves correctly in the local fixtures, and both R18 reproductions are repaired. The two Low issues are worth closing but need not hold ordinary supervised use merely to reach zero findings; prefer the small error-ordering fix first.

The existing broader-rollout gates remain: actual iOS/Android camera and recovery checks over HTTPS at the venue, expected shared-network/peak-load evidence, deployed client-IP trust validation and a credible public-registration abuse plan. Keep independent E2E release checks, staff recovery procedures, explicit history/search size budgets and the documented Google Wallet publishing decision. This report does not certify the live deployment or complete those operational checks.
