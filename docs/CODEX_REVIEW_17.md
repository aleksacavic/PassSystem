# PassSystem verification review 17

Reviewed **ef8e5bb..2f77e20**, including **c0c4ae5** (registration history and tab label) and **e356530** (R16 remediation), on `claude/passsystem-implementation-h1i74q` ([PR #1](https://github.com/aleksacavic/PassSystem/pull/1)). **No major blocker established for the intended supervised event. Four Low findings below; the very-large-event limitation requires attention before promising that scale.**

Only this report is committed. Application code, tracked tests, migrations and Edge Functions were not changed. No production service or secrets were accessed. No Expo, React Native, separate server or Docker infrastructure was introduced or changed. The deployment-record commit **2f77e20** arrived during review and was included; `IMPLEMENTATION_STATUS.md` now records frontend `e356530`, deployment `dpl_ECb56qdTMP3eyhcgc9nJ59cmmu8h`. This is repository/author evidence, not an independently queried production rollout.

## R16 findings - fixed? yes / no / partly

| Finding | Fixed? | Evidence |
| --- | --- | --- |
| R16-01 — search collapses near the small-screen breakpoint | **yes** | Search remains on its own row below 1024px and has a 288px minimum from that breakpoint. Current CSS/font/browser probes at 320/430/640/768/1024/1280px, with search and status active, found usable controls and no document overflow. The status/Export group wraps at 320px. |
| R16-02 — old attendee responses replace current results | **partly** | The original held search → Clear → fresh response → old response schedule is fixed. The sequence guard also suppresses obsolete errors after newer status, page and polling requests. However, a dismissed action's old callback can start a *new* latest-numbered request for obsolete filters; R17-01 reproduces that remaining query-ownership gap. |
| R16-03 — forward clock changes leave an expiry list stale on return | **yes** | Visibility/focus subscriptions now cause a fresh deadline check when visible; the submitted clock-jump schedule passes. Unchanged focus keeps array identity. Cleanup removes both added handlers. This is correction on return, not continuous detection of manual clock changes while a document remains focused with no event. |

Clear search also explicitly refocuses the input. Its regression passes and fails on the pre-fix component.

## Findings

### R17-01 — Low — A dismissed attendee action can reload obsolete filters as the newest request

**Locations:** `src/pages/admin/event/AttendeesTab.tsx:48`–`59` (numbered loader), `:296`–`299` (onDone callback capturing load), `:365` (completion calls captured onDone).

**Concrete reproduction, real component and deferred mocked API:**

1. Search `alice`, load Alice, open Revoke and confirm; hold the revoke response.
2. Cancel the pending dialog, then Clear search. The empty search's fresh request displays Bob from the unfiltered list.
3. Finish Alice's revoke. The old async handler calls its captured `onDone`, which calls the `load` captured for `search: 'alice'`.
4. This obsolete query increments the shared request counter, becoming the newest request. It displays Alice's filtered result under an empty search input. The probe confirms the last API query has `search: 'alice'` and the input remains empty.

**Impact:** the same kind of misleading filtered rows/totals as R16-02, until another correct load/poll. The mutation still targets the originally confirmed Alice registration, not Bob; no wrong-event mutation is established.

**Suggested fix:** make mutation-completion refresh invoke the *current* loader through a stable latest-callback/ref, or route it through a refresh signal handled with current query state. Additionally bind responses to the current query/page identity, not merely request start order. Preserve the intentional list refresh when a successful action's dialog was dismissed. Add this schedule for dismissed mutation completion after search/status/page changes; retain the prior dialog-identity tests.

### R17-02 — Low — An initially empty history cannot be refreshed

**Location:** `src/pages/admin/event/RegistrationHistory.tsx:43`–`45`, `:80`–`82`, `:101`–`107`.

**Concrete reproduction, real component with mocked API:** open history before the event has any registrations. Its first response is `[]`; the panel says “No registrations yet.” Later registrations may appear in the independently polled attendee list, but the history has no Refresh button. Closing and reopening does not fetch again because `times` is now an array rather than null. The probe arranges a nonempty second API response, closes/reopens the panel, and confirms only one call occurred and the empty message remains.

A successful refresh of a previously nonempty chart to zero would lead to the same state. Navigating to another tab and back, or otherwise remounting, is a workaround.

**Suggested fix:** render Refresh independently of `history.total > 0`, including empty and failed initial loads. Keep it disabled while loading. Add empty → new registrations → Refresh → nonempty, nonempty → refreshed empty → Refresh, and initial failure → retry tests.

**Impact:** stale optional analytics, not lost registrations or admission failure.

### R17-03 — Low — Fractional-offset zones can add a period before the first registration

**Location:** `src/lib/registrationHistory.ts:77`–`85`.

**Concrete reproduction:**

```ts
registrationHistory(['2026-10-29T08:40:00Z'], 'Asia/Kolkata')
// buckets: 13:00 -> 0, 14:00 -> 1
```

The only registration is at **14:10 local**, so the data span contains one local hour. Flooring its timestamp to 08:00 UTC starts the walk at **13:30 local**, introducing a zero bucket before the actual first local period. The loop clips keys after the last period but does not clip keys before the first. The same mechanism can introduce a preceding empty day when the first registration is just after local midnight in a fractional-offset zone and the chart uses daily buckets.

**Suggested fix:** derive both first and last local period keys before the walk and exclude periods outside those bounds. Preserve DST behavior and test single registrations on both sides of the half-hour boundary, quarter-hour zones, and daily starts just after local midnight.

**Impact:** a spurious leading zero period, not dropped registrations or an incorrect total/peak count. Dubai's whole-hour offset is unaffected.

### R17-04 — Low — Very large history inputs throw during rendering

**Location:** `src/lib/registrationHistory.ts:63`–`64`; invoked during render at `src/pages/admin/event/RegistrationHistory.tsx:48`–`50`.

**Concrete reproduction:** `registrationHistory(Array(200000).fill('2026-10-29T10:00:00Z'), 'Asia/Dubai')` throws `RangeError` in the review runtime because `Math.min(...times)` exceeds the engine's argument limit. The exact threshold is engine-dependent. The new caller loads every registration without a count cap, so this input size is not ruled out by the feature's API contract.

The calculation runs in `useMemo` during render, outside the loader's try/catch. At that size, opening history would reach the application's route error boundary rather than showing the attendee view. This is a helper-level reproduction, not an end-to-end event seeded with 200,000 registrations.

**Suggested fix:** compute extrema iteratively, reuse date formatters, bound/adapt the displayed bucket count and aggregate timestamps server-side for large events. Isolate analytics failures so they cannot replace the main attendee view. Add a large-array helper test and an explicit supported-size/load budget.

**Impact:** conditional analytics/view availability at very large scale; no stored-data change. Not a blocker for an ordinary supervised event, but do not claim this implementation supports six-figure event histories without addressing the load and render path.

## Registration-history assessment

| Area | Checked result / limitation |
| --- | --- |
| Hour/day boundary | Exactly 48 elapsed hours uses hourly buckets; 48 hours plus 1ms uses daily buckets. The decision is based on elapsed UTC span, not two local calendar dates. Endpoint-inclusive hourly data can legitimately produce 49 bars. |
| Single registration | UTC produces one bucket; fractional-offset case described in R17-03 may produce an extra leading zero. Empty/unreadable timestamps return empty or exclude those timestamps; total counts valid inputs only. |
| Zones and DST | Submitted Dubai/daily-local-date/Kolkata/Belgrade tests pass. Additional quarter-hour and Lord Howe/Belgrade totals probes preserve sum(counts) == total. Repeated local clock hours are intentionally merged into one key without an offset; this is a local-clock-hour aggregation, not separate elapsed-hour bars during fall-back. Spring-forward nonexistent clock hours are not fabricated. |
| Peak / scale | First maximum wins ties. Axis upper bound uses 1/2/5 powers; a middle tick is shown only when integral. Counts include revoked passes because the list is unfiltered, as stated. |
| Long spans | No maximum bar count: a one-year span produced **366 daily bars**; multi-year spans continue at one per local date. The algorithm still walks every UTC hour even for daily output. Titles omit the year, so multi-year tables/tooltips are less explicit than their full date keys. These are not promises of bounded rendering cost. |
| Cost | `listAllRegistrations` fetches full registration columns in sequential 1,000-row pages, including contact/terms fields unnecessary for a timestamp chart. It makes floor(N/1000)+1 requests, including a final empty request for exact multiples. No polling is added for the chart, so this cost occurs on first open and each explicit refresh. |
| CPU | One local helper measurement was about **94ms for 1,000 timestamps**, **802ms for 10,000**, and **772ms for two timestamps one year apart**. These are illustrative desktop-container timings, not a mobile or server load benchmark. Reconstructing Intl formatters per row/hour and recomputing the last key in the loop are avoidable costs; paging and browser memory add further cost. |
| Consistency | The multi-page read is not a single database snapshot. New registrations during retrieval may be included on later pages. Existing API ordering by registered_at then id is deterministic; this review does not establish an atomic analytics snapshot under concurrent edits/imports. |
| Lazy loading | Closed by default and no chart API call until opened; close/reopen reuses the result. Loading state prevents ordinary repeated initial loads and disables Refresh. No new access-control path: it uses the existing authorized registration reader; no API/RLS/grant changes were made. |
| Refresh / liveness | A positive-data Refresh probe replaces the old data. During refresh the prior chart stays visible with a busy/disabled button; failure retains old data plus an alert. Empty-result recovery is R17-02. A keyed A → B replacement probe confirms late A completion cannot populate B; EventDetail and its tab subtree are already keyed by event ID. |
| In-flight work after leaving | The liveness check prevents old UI ownership; it does not abort the paginated network work. That work may continue after tab/event navigation. Closing the accordion intentionally allows its same-instance request to complete. |

For larger events, prefer a bounded aggregation response containing only bucket counts; avoid transferring every attendee's full record simply to calculate a chart. A separate server/infrastructure change was neither implemented nor required for this review.

## Accessibility, layout and surrounding behavior

- The disclosure is a native button with `aria-expanded` and matching `aria-controls` when open. Toggle, Refresh and Show as table are keyboard-operable native buttons. The chart has a labelled list and named items; pointer hover updates a polite live readout. Bars are not keyboard focus stops and do not provide keyboard-triggered hover, but **Show as table** exposes all periods/counts without pointer use. The table has real headers. An actual screen reader was not run, so these are semantic/component checks, not an assistive-technology certification.
- The chart/table are alternatives with the same bucket data. The table is vertically scrollable; chart overflow is contained horizontally. In Chromium probes with 49 buckets at **320px**, the chart's internal scroll width was about **396px** within a **216px** viewport, with **no document overflow**. The chart is not required to squash every bar into a phone width. RTL paired with Arabic lang mirrors the flex layout and chronological direction; the admin copy is still English rather than a new localized-admin feature.
- Real component markup, freshly built CSS and self-hosted fonts were inspected offline at 320/430/640/768/1024/1280px in LTR and RTL. Search widths were **288/398/608/736/288/about327px**; status widths were at least 192px in those probes. This verifies R16-01's sizing and the chart's overflow containment without starting a server. It does not exercise browser React interactions or replace the submitted E2E run.
- “Scan activity” changes only the visible tab label. The `activity` key and `?tab=activity` URL remain intact; event-ID keys and summary polling are unchanged. Switching away from Attendees unmounts history; returning starts a fresh collapsed instance, as expected for the existing conditional tabs.
- **Latest attendee request:** successes, totals and errors share the same sequence fence. Extra probes confirm stale rejection suppression after newer status/page/poll requests; the existing new test confirms stale search success suppression. A poll that starts later supersedes earlier work even for the same query. The remaining issue is initiating new work from an obsolete captured query (R17-01), not failure of the integer comparison.
- **CSV export does not need the same latest-list-request fence:** it intentionally exports all registrations for the captured event, independent of the current search/status/page. An explicitly requested A download may complete after navigation without becoming a B export. The existing export builds its filename from captured A as well. Its local post-await setters cannot overwrite a different keyed event instance. This review establishes no mislabeled or wrong-event CSV export; cancelling it merely because a filter changed would alter the intended behavior.
- Saved-pass return subscriptions respect visibility and remove their matching focus/visibility handlers on unmount. The prior expiry timer cap/last-subscriber cleanup remains unchanged. Unchanged snapshots retain identity, so a focus/visibility notification alone does not produce a render loop.

## Independent validation and sensitivity

| Check | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Full unit/component suite | **159/159 passed**, 29 files |
| Integration against existing local Supabase | **138/138 passed**, 15 files; no new stack/infrastructure started |
| Additional ignored probes | **24 passed** across three files, including existing controls, the finding reproductions, status/page/poll obsolete errors, refresh/keyed replacement, bucketing boundaries and cost measurements. Reproduction probes assert observed defects, not a repaired result. |
| Production build / bundle-secret scan | Passed with placeholder public configuration; 19 generated files checked |
| Offline browser layout | Current captured component DOM, installed Chromium, current CSS/fonts; screenshots inspected. No separate server started. |
| Browser E2E | **Not independently rerun** under the server constraint. Submitted **10/10** remains author-reported evidence. |

For R16 sensitivity, an ignored historical fixture kept current tests but restored the literal **c0c4ae5** AttendeesTab and passStorage implementations. The two targeted files produced **3 failed / 13 passed**: held-search success suppression, Clear-search refocus, and visibility-return expiry failed on their intended behavioral assertions. **Focus with nothing expired passed on both versions** and is correctly an invariant guard, not evidence of a newly repaired path. The toolbar's historical E2E sensitivity was not independently run; its earlier failure and current browser sizing are recorded separately. New history tests were evaluated as new-feature coverage, not counted as historical failures caused by absent modules.

Fixtures are ignored under `tests/.artifacts/review17/` and `/tmp/passsystem-review17-before`. The standard integration setup temporarily adjusts local test rate limits and restores defaults; production was untouched.

## Readiness

**Reasonable to deploy/use for the intended supervised event after a real-device venue rehearsal.** No new major blocker was established. The remaining filter-refresh and empty-history defects are worthwhile small fixes, with poll/tab-remount workarounds; fractional-zone presentation is minor, and the large-history path needs a size/load decision before use at that scale. Do not delay the supervised event solely to reach zero Low findings.

The broader operational gates from review 16 remain: actual iOS/Android camera and recovery testing over HTTPS on the venue network, shared-network/peak-load evidence, deployed client-IP trust validation and a credible public-registration abuse plan. Retain independent E2E release coverage, staff recovery procedures and the documented Google Wallet publishing decision. This frontend review neither verified the live deployment nor completed those operational checks.
