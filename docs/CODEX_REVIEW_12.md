# PassSystem verification review 12

Reviewed **9a2797f..082737f**, including code change **3570022** and deployment documentation, for [PR #1](https://github.com/aleksacavic/PassSystem/pull/1). **Result: one Medium and one Low finding.** The original R11-01 form-identity defect is fixed. The explicitly requested broader lifecycle sweep found actionable record-state retention in EventDetailPage/tabs, and a remaining late-completion navigation issue in the editor.

Only this report is committed. Application source was not modified. Component/router probes used mocked API boundaries and ignored local artifacts; integration tests used the existing local stack. No production, migration, Edge Function, separate server or Docker infrastructure change was made. Production deployment details were treated as supplied context, not independently queried.

## R11 findings – fixed? yes / no / partly

| Finding | Fixed? | Verification |
| --- | --- | --- |
| R11-01 | yes | The keyed editor resets state across event IDs and edit/create transitions. The extra `loaded.id === id` check protects render/submit identity even when A and B share a timestamp. A pending or failed B load offers no form/save, B success saves B's version, and New starts empty and calls create. |

**Combined R9-01 / R10-01 / R11-01 assessment:** The identified stale-write, failed-initial-load, and retained-form-across-IDs failures are now corrected. There is no identified normal `src/` event UPDATE by ID alone. The editor's complete asynchronous lifecycle is not finished: an operation dispatched before leaving A can navigate away from a newly opened B editor when it completes, as R12-02 demonstrates. The detail-page problem in R12-01 is outside the corrected editor wrapper, not a regression introduced by it.

## Findings

### R12-01 — Medium — Event detail and its unkeyed tabs retain actionable records from the previous event

**Location:** `src/pages/admin/EventDetailPage.tsx:25–45`, `:67–76`, `:161–164`; `src/pages/admin/event/AttendeesTab.tsx:30–34`, `:42–49`, `:228–237`; `src/pages/admin/event/StaffTab.tsx:10–22`, `:40–45`.

Unlike the editor and scanner, the detail page is not keyed to the route's event ID. It neither clears existing event/summary/error state nor ignores old load results when the ID changes. Its same-tab child instances also retain their own lists and selected actions across new event props. This permits actions on the previous event while another event is current in the route or header.

**Concrete reproductions using the real components/router and mocked APIs:**

1. **Publish A from B's route.** Load draft event A, navigate to `/admin/events/B`, and defer B's event load. A's detail and Publish action remain. Click Publish: observed `updateEvent('A', {status:'published'}, ...)`, despite the current B route. The expected no-action-during-B-load assertion failed.
2. **Revoke A's attendee under B.** Open A's Attendees tab and its Revoke dialog. Navigate to B's Attendees tab and let both B's event and B's attendee list load. The header says Event B, but A's selected dialog remains. Confirm: observed `revokeRegistration('reg-A')`. The expected empty call list failed.
3. **Late A replaces loaded B.** Start a delayed A event load, navigate to B and finish B's load, then resolve A. The detail heading changes back to **Event A** under B's route. No response-generation check prevents this.
4. **Old staff remains actionable.** Rerender the real StaffTab with event B while B's list is pending. A's staff row remains; Remove calls `removeEventStaff('assignment-A')`. This is the same prop transition the unkeyed detail child receives.

These probes recorded frontend calls; no real event was published or attendee/staff record removed. They establish a wrong-record-action problem for users otherwise authorized to manage those records, not an authorization bypass. Existing backend checks do not know which event the operator intended to be viewing.

**Suggested fix:** Bind the entire detail-screen state tree to its route identity, as done for EventEditor/Scanner. Key the owner containing the event, summary and tabs by event ID, and fence asynchronous reads/completions to that identity. If tabs can independently receive a different event prop, remount/reset their lists, filters and selected modals by ID and reject actions whose selected record belongs to a different event. Closing a modal alone does not fix stale parent loads or old list responses. Add the four schedules above, including pending/failing B and late A responses.

### R12-02 — Low — A save/delete completion from an unmounted editor redirects the current editor

**Location:** `src/pages/admin/EventFormPage.tsx:94–97`, `:113–115`.

Keying the editor prevents its local state from carrying over, but an already-running async handler still holds a usable router `navigate` function. Its success continuation navigates without checking that the initiating editor is still current.

**Concrete reproduction:** With the real EventFormPage/router and deferred mocked mutations:

1. Save event A, keeping its update promise pending.
2. Navigate to B's edit page and type an unsaved change there.
3. Resolve A's save. The old, unmounted editor navigates to **A's detail page**, removing B's editor and its unsaved change.

A second probe started A's deletion, moved to B and typed a change, then completed the deletion. It redirected B to **`/admin`**. Both assertions that the router should remain on B's edit URL failed. No real database deletion was performed.

The operation already dispatched for A may legitimately finish; this finding concerns its obsolete UI navigation, not undoing a successful server mutation.

**Suggested fix:** Guard post-await navigation and other UI completion effects with the initiating editor's mounted/session identity. Invalidate it on unmount/route change. Test delayed create/save/delete completion after moving to another editor, while preserving the backend operation's result and avoiding an unwanted redirect.

## Wider page/record sweep

| Page / component | Result |
| --- | --- |
| EventFormPage / EventEditor | Route key and loaded-record identity now protect reads/forms. Pending mutation navigation remains: R12-02. |
| EventDetailPage | Retains event, summary, error and publishing state, and accepts stale load results: R12-01. A prior error also is not cleared merely by changing IDs. |
| AttendeesTab | Retains rows, search/filter/page and selected action across event props. A's modal survives B's completed load; verified wrong-record API call in R12-01. |
| StaffTab | Retains staff rows, typed assignment email/role and errors while a new event loads. Verified stale assignment removal call in R12-01. |
| ActivityTab | Logs/names/error persist across event props. Its async log→name lookup has no current-event check; stale results can replace the new event's display. Static source inspection; no separate runtime reproduction claimed. |
| OverviewTab / LatestAtTheDoor | LatestAtTheDoor retains logs/names and has no event-generation check around its reads. Parent route remounting should also reset this subtree. Static source inspection. |
| UsersPage (global Staff/accounts screen) | One `/admin/users` route, with no user-ID route parameter or per-user detail screen. Rows/actions use their explicit selected user IDs. No equivalent route-parameter retention case exists in the current route map; this was not an audit of every account-operation race. |
| Scanner | Already renders `<Scanner key={eventId}>`; gate, history, view, event and camera state are per event instance. Existing in-flight operations may complete, but do not populate the replacement scanner. Three ordinary real-page/hook completion cases were rerun and passed. |

The event “sub-pages” are currently query-selected tabs (`?tab=...`) rendered by EventDetailPage, not separate `/admin/events/:id/*` route components. Changing the query-selected tab unmounts that tab; changing the event ID while keeping the same tab currently does not. That distinction is central to R12-01.

## API and editor fix verification

`updateEvent` now normalizes a missing/null expectation object before testing its keys. All six refusal inputs in the checked-in test—empty object, empty timestamp, undefined timestamp, undefined status, undefined whole object and null whole object—return `missing_version` before the query's ID filter is reached. The source guard still precedes query construction. The type-level requirement remains unchanged and current typecheck passes.

The keyed editor owns form/original/loading/error/attempt state. Its `loaded` check uses the record ID, not timestamp uniqueness. The timestamp is sent unchanged from the matching loaded record. The original initial-load error/retry behavior and versioned stale-save protection remain covered by the passing tests. The source search still finds only the shared helper as a direct event UPDATE writer, called by the form with a timestamp and Archive/Restore/Publish with displayed status; no new unconditioned event writer was added.

## Tests and sensitivity

| Verification | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Unit | 125/125 passed, 25 files |
| Existing local integration suites | 138/138 passed, 15 files |
| Three ordinary scanner completion cases | 3/3 passed |
| Additional detail/tab record-isolation probes | Four intentionally failing cases recorded in R12-01 |
| Additional pending editor-operation probes | Two intentionally failing cases recorded in R12-02 |

The reported author/CI browser result was not independently rerun in this round. No new browser server or infrastructure was introduced. The record-isolation probes mounted actual components; API boundaries were mocked, so they establish dispatched identifiers/navigation rather than live backend mutations.

**L sensitivity:** In an isolated copy, restored the literal `350a368` EventFormPage and API while retaining the current tests. Outcome: **3 failed / 7 passed** across the two targeted files:

- A loaded→B pending/failure test failed on the actual `updateEvent(B, ..., A-version)` call before its later UI checks.
- Edit A→New failed because A's old form remained, rather than an empty form.
- The expanded runtime-expectation test failed on the old TypeError for an undefined whole object; earlier empty-member refusal cases still passed.
- The B-success save test passed before and after: it is the intended identity/version control with equal timestamps.
- The two earlier load-error/retry tests and three prior API expectation/conflict cases also passed.

The type-only wrapper continues to pass; the compiler, not that wrapper's runtime execution, enforces required expectations. No missing-method or missing-file failure was counted. No database/Edge counterfactual was performed.

## Readiness

Core registration and scanner behavior continue to pass their existing checks, and the editor's previously identified route-state defect is resolved. **A supervised single-event pilot is reasonable. Before wider multi-event administration, close R12-01:** it produces actions on the previous event, not just cosmetic stale text. R12-02 is lower priority but should be included in the same lifecycle cleanup because it can discard work in another editor.

These are concrete remaining functional issues, rather than a requirement to reach an arbitrary zero-finding score. This scoped review does not verify the live deployment or replace a real-device rehearsal at the venue.
