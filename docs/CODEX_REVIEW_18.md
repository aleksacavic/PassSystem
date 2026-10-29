# PassSystem verification review 18

Reviewed **53ab5eb..d084acd**, including **6dd1683** (shared history/check-in chart) and **17e5db6** (R17 remediation), on `claude/passsystem-implementation-h1i74q` ([PR #1](https://github.com/aleksacavic/PassSystem/pull/1)). **All four R17 findings are fixed in their reported schedules. No major deployment blocker established; two Low follow-ups below.**

Only this report is committed. Application source, tracked tests, migrations and Edge Functions were not changed. No production service or production secrets were accessed. No Expo, React Native, separate server or Docker infrastructure was introduced or changed. Repository deployment record `d084acd` names frontend `17e5db6`, deployment `dpl_FzCiqkF8BS9dWzmBeKNpNcUuzwbm`; its live status was not independently queried.

## R17 findings - fixed? yes / no / partly

| Finding | Fixed? | Evidence |
| --- | --- | --- |
| R17-01 — dismissed action refreshes obsolete filters | **yes** | Completion calls the latest loader ref. The submitted held-revoke → dismiss → Clear → finish schedule now asks for the empty search and retains Bob. A layout-effect query identity plus request sequence fences both success and error. Current same-filter polling and page 1 → 2 → 1 responses were accepted in extra probes. |
| R17-02 — empty history has no Refresh | **yes** | Empty and failed initial loads offer Refresh and can recover to data. Refresh also remains available after a computation failure. Ordinary refresh stays disabled while loading. |
| R17-03 — fractional-offset walk adds a leading period | **yes** | First/last local keys bound the walk. Submitted Kolkata/Kathmandu single-period and daily-local-midnight tests pass. The different shortened-period DST coverage gap in R18-01 was previously undetected, not failure of those clipping schedules. |
| R17-04 — large timestamp array throws during computation | **yes** | Iterative extrema handle the submitted 200,000 identical timestamps with one bucket. Cached formatters reduce repeat construction; year-spanning titles include the year. The registration reader selects timestamps only. Computation exceptions are caught inside the panel, confirmed by an extra probe. This is not a claim of bounded six-figure-event cost or a universal descendant-render error boundary. |

## Findings

### R18-01 — Low — The UTC-hour walk can omit a counted period at a half-hour DST transition

**Location:** `src/lib/registrationHistory.ts:104`–`115`.

**Scope:** an existing bucketing limitation shared by both charts, now also used for check-in history. It is not introduced by the new first/last clipping fix.

**Concrete reproduction, real helper:**

```ts
registrationHistory([
  '2026-10-03T14:45:00Z', // Lord Howe: 4 Oct 01:15
  '2026-10-03T15:45:00Z', // Lord Howe: 4 Oct 02:45
  '2026-10-03T16:15:00Z', // Lord Howe: 4 Oct 03:15
], 'Australia/Lord_Howe')
```

On that spring transition the local clock advances by 30 minutes. The helper reports **total = 3**, but returns only **01:00 → 1** and **03:00 → 1**. The local 02:00 period exists for only half an hour; whole UTC-hour sample points skip it, even though `counts` contains its timestamp. The fallback restores only an absent *first* period, not an omitted interior period. Thus chart/table sums are 2 while the headline says 3.

**Suggested fix:** generate buckets using actual local-period boundaries/transitions, and ensure every counted key is included independently of the zero-fill sampling walk. Retain a deterministic chronological order. Add the schedule above, an invariant that sum(bucket counts) equals total, and shortened-period tests with zero and nonzero counts. Do not assume a whole-UTC-hour stride visits every existing local clock hour.

**Impact:** inaccurate optional analytics in a fractional-DST zone. Dubai is unaffected; no registration, scan decision or admission record is changed. Previously checked ordinary Kolkata and Belgrade schedules remain valid but do not cover Lord Howe's shortened hour.

### R18-02 — Low — Overlapping polls can indefinitely discard healthy but slow attendee responses

**Location:** `src/pages/admin/event/AttendeesTab.tsx:55`–`65`, `:76`; interval behavior in `src/lib/usePolling.ts:12`–`17`.

**Scope:** an existing consequence of the latest-*started*-request policy, not a new false comparison in `shownQuery`.

**Concrete reproduction, real AttendeesTab and polling hook with controlled timers:** make every `listRegistrations` call successfully resolve after **16 seconds**, without changing any filters. The first request starts at 0s; polling starts another at 15s. The first resolves at 16s but is rejected because its sequence is no longer latest. This repeats for subsequent requests. After advancing **75 seconds**, six requests have started, several have successfully completed, and the list still has no rows and shows its initial spinner. The query identity matches throughout; the sequence condition rejects each completion.

With an already-loaded list the same schedule leaves stale data rather than an initial spinner. Actual network latency can exceed the polling interval even if database execution is fast; this probe simulates successful delayed responses, not a production load test.

**Suggested fix:** avoid starting another poll while a request for the same query is in flight, with an appropriate timeout/cancellation strategy; allow changed query/page state to supersede it. Alternatively accept a matching-query completion if it is newer than the last *applied* response, while preventing late responses from replacing already-applied newer data. Add sustained latency greater than the poll interval to the response-order tests.

**Impact:** attendee-list responsiveness on a consistently slow network; no wrong-ID mutation. It is separate from the original obsolete-filter refresh, which is now fixed. It does not block ordinary supervised operation on a working venue network, but is worth closing for degraded-network usability.

## Check-in history: semantics, access and load

**“Admitted only” is appropriate for a check-in history.** The new reader explicitly filters `event_id` and `result = 'admitted'`, orders ascending by `attempted_at` then `id`, selects only `attempted_at`, and pages in ranges of 1,000. A refused repeat remains in the last-100-attempt list but is not a second check-in. History describes retained admitted-log occurrences, rather than current occupancy or the number of all scan attempts. Retained logs can outlive the operator account; no new dependency on a live operator profile or current registration name is introduced.

A supplementary local test invoked the **actual new API readers** through ordinary Supabase clients, using disposable local users/events and the existing fixture helpers. It admitted one registration, attempted the same pass again and then read history:

| Caller | `listAdmittedScanTimes` for the target event | Interpretation |
| --- | --- | --- |
| Administrator | One timestamp | Administrator satisfies the existing organizer helper. |
| Assigned organizer | One timestamp | Can read their event's admitted log. |
| Assigned operator | Empty array | RLS filters the rows; this is not a query-level 403. The normal EventDetail operator-access screen does not expose the management tabs. |
| Organizer assigned only to another event | Empty array | No cross-event log read. |
| Anonymous | Request refused | Table SELECT privilege is unavailable. |

The local event contained one `admitted` and one `already_used` log; the new reader returned only one timestamp. The timestamp-only registration reader also returned one row to admin/organizer and none to operator/other-event organizer.

The unchanged policy is `admission_logs_select_organizer` in migration 002, using `private.is_event_organizer(event_id)`; the helper includes administrators. No later migration replaces that policy, and no grant/RLS change is part of this review range. An RLS-filtered empty result must not be treated as a global fact that an event has no check-ins when calling this helper outside the authorized UI.

**Cost:** both timestamp readers perform floor(N/1000)+1 sequential requests, including a final empty request for exact multiples. Registration history no longer transfers names, contacts and terms fields just to chart timestamps. The scan reader likewise transfers timestamps only. Ordering is deterministic; pagination is still an offset-based, multi-request read rather than an atomic snapshot. Reads arriving during ongoing admissions can include a moving tail. No finite row count, request budget or bucket cap was added, and leaving the page does not abort already-running pagination.

At 200,000 timestamps, retrieval still means roughly 201 sequential requests, plus timestamp-array memory and synchronous local formatting. The checked-in helper test now passes at that size, but it is not a six-figure end-to-end load test. Long date spans still walk every UTC hour and render daily buckets with no aggregate cap. A server-side aggregate or an explicit supported-size budget remains the appropriate next step before promising that scale.

## Shared panel, polling and error behavior

- **Activity polling does not refetch all check-ins.** An extra test uses the real ActivityTab and `usePolling`: opening the chart fetches its timestamps once; advancing 30 seconds produces four activity-list loads including the initial load, but still only one chart load. Clicking chart Refresh performs a second timestamp load and updates the bars. The list remains latest-100 attempts; the chart is full authorized history as of its own manual load. Their totals/timelines can legitimately differ until Refresh.
- **A new load function prop is not itself a reload signal.** Parent poll rerenders create a fresh wrapper closure, but HistoryPanel does not fetch on its identity change. An additional same-instance rerender probe confirms this, followed by a successful explicit Refresh. This avoids a full-history request every 10 seconds.
- **Refresh recovers empty/failure cases.** Its normal controls serialize loads: loading disables Refresh, and opening while a first load is pending does not dispatch another. A failed refresh retains prior data plus an alert; empty data is a successful state with an available Refresh. No ordinary overlapping Refresh race was established.
- **Event ownership is retained.** EventDetail/tab trees are already keyed by event ID. A new shared-panel test starts A's request, replaces it with keyed B, finishes A, and confirms B remains collapsed/empty until deliberately opened; B then displays B's period. `useIsCurrent` prevents the discarded instance's state updates; it does not cancel network work. Closing/reopening the same panel intentionally preserves cached data, and switching away from the tab remounts a fresh collapsed panel on return.
- **Error isolation has a precise boundary.** The try/catch encloses `registrationHistory`, and loader exceptions are caught separately. A probe with an invalid time-zone computation produces the in-panel chart error, leaves a surrounding-list sentinel rendered and offers Refresh. It does not rethrow through the route. This is not a React error boundary for arbitrary descendant failures: HistoryChart still computes `Math.max(...buckets.map(...))` outside that try/catch. Its argument count depends on *period count*, not timestamp count; the repaired 200,000-identical-timestamps case has one bucket. No ordinary-event descendant-render failure was demonstrated, and this distinction is not grounds to mark the original large-array fix unfixed.
- **Registration-history behavior is preserved.** It still loads only on open/Refresh, counts all registration timestamps including subsequently revoked passes, uses event-zone buckets, and offers the same table/chart alternatives. The submitted singular/plural nouns and the new Check-ins table header are appropriate. Shared layout/accessibility structure is unchanged: native disclosure/actions, labelled bar list, polite pointer readout and a table alternative. No actual screen reader or real-device browser session was run this round.

## Query-match guard and valid responses

`shownQuery` serializes stable primitive `[debounced, status, page]` values, not a fresh object's identity. Its layout effect runs before the passive loading effect. The query field is the *debounced* search, so the 250ms interval while typing intentionally still belongs to the previous query; that is not a corrupted identity. Event ID is outside the serialized tuple because the mounted tab is already event-owned/keyed.

Extra positive tests accept a current page after **page 1 → page 2 → page 1**, and a same-query visibility-triggered poll with unchanged filters. The submitted modal-completion test confirms the current loader ref. Both success and error require the query and sequence to match. No incorrectly dropped current response was found from equality alone. The practical remaining drop problem is overlapping polls superseding all slower completions, as R18-02 distinguishes.

CSV export remains an explicit full-event download, independent of list filters, and was not changed. It should not be cancelled merely because search/status/page changes while the requested event's file is being prepared.

## Independent validation and sensitivity

| Check | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Full unit/component suite | **167/167 passed**, 30 files |
| Integration against existing local Supabase | **138/138 passed**, 15 files; no stack/infrastructure started |
| Extra component/helper/API probes | **19 passed**, four ignored files: existing attendee controls, current-response acceptance, sustained-latency reproduction, DST reproduction, panel isolation/keyed replacement/manual snapshot, timestamp-reader pagination and page-failure propagation, and activity/chart polling interaction |
| Extra local role/API test | **1 passed**, actual timestamp readers with disposable local role/event fixtures; no production credentials or services used |
| Production build / bundle-secret scan | Passed with placeholder public configuration; 19 generated files checked |
| Browser E2E | **Not independently rerun** under the no-separate-server constraint. Submitted **10/10** and CI remain author-reported evidence. |

Pagination probes check timestamp-only selects, event/admitted filters, deterministic ordering, ranges 0–999 then 1000–1999, and that a later page error rejects instead of returning a misleading partial success. These query-chain tests complement the small actual local RLS fixture; they are not a large real-database performance test.

Sensitivity restored literal **6dd1683** `registrationHistory`, HistoryPanel and AttendeesTab implementations in an ignored historical fixture, retaining current wrappers/tests/API. Across the three targeted files: **6 failed / 16 passed**. The failures were the dismissed-action query, empty and failed-load Refresh, fractional-offset clipping, 200,000-item argument limit, and cross-year title. These were behavioral failures, not missing modules/methods. Error isolation, the new timestamp-only API and new scan feature were checked separately; these six failures must not be represented as historical sensitivity proof for every accompanying invariant or optimization.

Fixtures are ignored under `tests/.artifacts/review18/` and `/tmp/passsystem-review18-before`. Reproduction tests assert observed defects, not fixes. The standard integration setup temporarily adjusts local test rate limits and restores defaults; production was untouched.

## Readiness

**Reasonable to deploy and use for the intended supervised event after a real-device venue rehearsal.** The R17 fixes are effective, the new chart uses existing access control correctly, and no new major blocker was established. The fractional-DST chart and slow-poll issues are Low follow-ups; do not delay ordinary supervised use simply to reach zero findings. The slow-poll fix has more practical value for a poor venue network than the unusual-zone analytics edge.

For a larger unsupervised public rollout, the existing operational gates remain: actual iOS/Android camera/recovery checks on HTTPS at the venue, shared-network/peak-load evidence, validation of deployed client-IP trust and a credible public-registration abuse plan. Keep independent E2E release checks, staff recovery procedures, an explicit history-size/load budget and the documented Google Wallet publishing decision. This scoped frontend review did not certify the live deployment or perform those acceptance checks.
