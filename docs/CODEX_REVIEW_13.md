# PassSystem verification review 13

Reviewed **8b89b78..b95256b**, including code change **fdbb1bb** and deployment documentation, for [PR #1](https://github.com/aleksacavic/PassSystem/pull/1). **Result: two Low findings; no new major blocker established.** Both findings from review 12 are fixed in the exercised schedules. The additional issues below are pre-existing callbacks identified by the explicitly requested wider async-handler sweep, not regressions attributed to the new helper.

Only this report is committed. Application source was not modified. Probes mounted real frontend components with mocked API boundaries and used ignored local artifacts. Integration tests used the existing local stack. No production, migration, Edge Function, separate server or Docker infrastructure changes were made. Supplied production/CI results were not independently queried.

## R12 findings – fixed? yes / no / partly

| Finding | Fixed? | Verification |
| --- | --- | --- |
| R12-01 | yes | EventDetail and every active tab are now owned by the route/event identity. A's Publish/attendee dialog/staff rows disappear on moving to B; late A data and Publish completion do not overwrite B. All five detail-page regression cases pass. |
| R12-02 | yes | Save/delete completion checks the initiating editor's liveness before navigation or UI updates. Both delayed-A-operation tests retain B's edit URL and unsaved change. |

The editor fixes from R9-01, R10-01 and R11-01 remain intact. The requested initial-load, conditional-save, route-identity and pending-editor-navigation failures are now corrected. The remaining callbacks outside these screens are assessed separately below.

## Findings

### R13-01 — Low — Registration completion redirects a guest who already went Back

**Location:** `src/pages/public/RegisterPage.tsx:117–126`, with local-state completion paths at `:127–154`.

After registration resolves, the page saves the issued pass and navigates to it without checking whether the initiating page is still current. The saved credential is useful even after leaving; the obsolete navigation is the problem.

**Concrete reproduction:** In a real RegisterPage/router probe with a deferred mocked registration response:

1. Start at Home, open the registration page, fill valid names and submit.
2. Before the response finishes, navigate Back to Home, unmounting RegisterPage.
3. Complete the successful registration response.

Observed route: **`/pass`**, instead of staying at **`/`**. The departed component's `navigate` callback redirected the current page. The test failed on that route assertion. No real guest was registered by this probe.

**Suggested fix:** Preserve the issued pass in storage after successful registration, even if the initiating screen has gone away, but guard navigation and component-owned error/loading changes with the initiating route/instance identity. A mounted-only guard is insufficient if the same RegisterPage instance is reused with another slug; use a slug-owned instance or captured route identity as well. Add a deferred registration→Back/other-event completion test, checking both credential preservation and no forced navigation.

### R13-02 — Low — Completion of a dismissed attendee dialog closes a newer dialog

**Location:** `src/pages/admin/event/AttendeesTab.tsx:293–305`, especially `onClose()` at line 301; the parent action state is at `:33–35` and `:228–237`.

ActionModal still calls its parent callbacks after its request resolves without checking that the modal remains mounted/current. The parent AttendeesTab can remain mounted when one dialog is closed and another is opened, so React ignoring the old modal's local state updates does not protect the parent's current `action`.

**Concrete reproduction:** Using the real AttendeesTab and Modal with mocked mutations:

1. Open guest A's Revoke dialog and confirm; keep A's request pending.
2. Close that busy dialog with Cancel, then open guest B's Revoke dialog in the same event.
3. Confirm that B's dialog is displayed, then complete A's request.

Observed: **B's dialog disappears**, despite no action on B. The assertion that the current dialog should remain failed. A's original request may legitimately complete; the problem is its obsolete `onClose` clearing the newer action. No real pass was revoked.

**Suggested fix:** Guard modal-owned completion effects and `onClose` with current modal identity/liveness, or make the parent close only the exact action instance that completed. Keep any appropriate list refresh separate and bound to the still-current parent/event. Add close-A→open-B→A-completes cases for revoke/restore and the relevant reissue completion path.

Neither finding dispatches the previous review's new wrong-event mutation. These are navigation/dialog interruptions, so they are lower priority than the repaired record-identity failures.

## Async-handler sweep

Not every missing liveness check is a defect: React discards local state updates to an unmounted component, and some user-requested server/download/auth operations should finish. The important distinction is whether completion acts on a newer screen, parent selection, browser history, or other global state.

| Candidate | Current behavior / assessment |
| --- | --- |
| EventForm save/create/delete | Guarded after await by `isCurrent`; operations finish without obsolete redirects or UI updates. Verified by the new save/delete tests. |
| EventDetail Publish | Guarded before setting event, refreshing summary, reporting error and clearing publishing state. Verified for late completion and ordinary success. |
| AttendeesTab ActionModal | Success/error/finally setters are not guarded; parent `onDone`/`onClose` can still run. R13-02 reproduces interference with a newer dialog in the same retained parent. Event route changes now discard the whole parent, preventing the older cross-event dialog issue. |
| AttendeesTab CSV export | No liveness guard after list retrieval. It creates the download using the event/slug captured when requested and updates only its old local state. Completing an explicitly requested A export after leaving A is not inherently incorrect; no mislabeled B export or new wrong-record mutation was established. |
| Overview QR/image export | Similarly completes the requested captured-event download and updates its old local busy flag. No route navigation. This is distinct from showing old data as the new event. |
| StaffTab add/remove | No current-instance checks after await; callbacks can refresh the captured old event and set old state. Route keying now discards the A tab before B exists, so those callbacks do not update B. Typed email/role/rows reset with the tab. No new incorrect-target call was established. |
| RegisterPage submit | No liveness/route check after await; global pass storage plus navigation follows completion. Credential preservation should remain, but R13-01 establishes obsolete navigation. Catch/finally also update component state without such a check. |
| AccountPage | Password response updates state without a liveness check; password-setup success also clears the global setup requirement and navigates. The app Root already forces a session needing password setup onto `/account`; ordinary password changes do not take that navigation branch. No separate real-auth race was executed or claimed. Preserve intended global setup completion when refining UI liveness. |
| InvitePage | Accept success still marks global password setup, replaces browser history and navigates after await, without a current-instance check. Auth/session completion has global semantics, and Root intentionally routes password setup to Account. This is an unguarded source path, but no independent live-auth failure scenario is claimed. Any cleanup must distinguish necessary session/setup state from obsolete page/history effects. |
| UsersPage / Staff accounts | Invite/link/role/remove handlers update local state and refresh the global account list without current checks. The old page's ref is null after unmount, so optional scrolling does nothing. No per-user route identity is reused and no post-await navigation exists here. This was a lifecycle source check, not a re-audit of the server operations. |
| LoginPage | Post-await form state lacks liveness checks, but the handler does not explicitly navigate; session-driven navigation is rendered while the page exists. No additional navigation defect established. |
| Scanner | Camera callbacks retain their generation/track checks. The event-keyed scanner isolates history/view/gate. An already-dispatched admission can complete with feedback and an old-event refresh/local-state updates; it does not redirect or populate the replacement scanner. Those completion sounds are not claimed to be cancelled. |

The ordinary additional probes did not exercise live password changes, invite redemption or global account mutations. Their unguarded source paths are listed rather than presented as unverified new findings.

## Keys, tabs, polling and the new helper

A targeted positive test used the real EventDetailPage, router and **real usePolling**, with mocked API calls and fake time:

- The parent summary polled after ten seconds.
- Switching `?tab=attendees` to Staff selected the new tab while retaining the same event owner; `getEvent` did not reload merely because the tab changed.
- Advancing time after leaving Attendees did not run its cleared polling interval.
- Switching to Overview and publishing updated the event and invoked a summary refresh; Publish disappeared as expected.
- Moving to B and advancing thirty seconds did not make A's summary interval fire again; B stayed shown.

The test passed. Tab changes still intentionally unmount the previous tab, as before; event changes now unmount the entire state tree. Child keys remain stable for the same event and do not reset the parent merely on a query-tab change or successful Publish.

Two additional helper tests passed: `useIsCurrent` stays true after StrictMode effect replay and ordinary rerender, becomes false on unmount, and an old instance's callback does not become true when another instance mounts. This is an instance-liveness check, not cancellation of a server request or a replacement for request/record identity when one component is reused.

Old getEvent/summary/log reads can still call setters on discarded instances; the keys prevent those values from reaching the new event. The helper is not being represented as automatically guarding every promise in the application.

## Tests and sensitivity

| Verification | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Unit | 132/132 passed, 26 files |
| Existing local integration suites | 138/138 passed, 15 files |
| Real-page tab/polling/Publish refresh test | Passed |
| Additional helper-instance checks | 2/2 passed |
| Additional current-code failure probes | Two intentionally failed assertions for R13-01/R13-02 |

The author's 9/9 browser result was not independently rerun in this round. No new server or infrastructure was introduced. All extra frontend API boundaries were mocked; the probes establish UI calls/navigation/dialog behavior, not live mutations.

**L sensitivity:** In an isolated source copy, restored literal `3570022` EventDetailPage and EventFormPage while retaining the current tests. All **seven** new cases failed on the stated behavior:

- Four detail/child-isolation cases: obsolete Publish/revoke/staff actions or A displayed under B.
- Late A Publish after B: A's result replaces B on the old page.
- Late save and late delete after moving to B's editor: obsolete navigation removes B and its unsaved change.

The five earlier editor tests passed on both implementations. Total historical result: **7 failed / 5 passed** across the two files. No M mutation, missing-module or missing-method failure was used as sensitivity evidence. The new helper file remained present but unused by the restored historical components.

## Deployment / use recommendation

**No new major deployment blocker was established.** The previous wrong-event administration problem and editor redirect problem are fixed in the tested schedules. Based on these local results, deploying/using the app for the intended supervised event is reasonable, with a real-device rehearsal before relying on it at the door.

R13-01 and R13-02 are worthwhile follow-up fixes, but should not by themselves hold deployment for an abstract zero-finding target. This is now predominantly edge-case lifecycle cleanup. This scoped review is not a new whole-system certification and did not inspect the live deployment or change the previously documented operating assumptions.
