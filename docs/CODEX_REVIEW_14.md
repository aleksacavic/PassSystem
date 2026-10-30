# PassSystem verification review 14

Reviewed **06867ed..63cfd59**, including frontend change **d87659e**, on `claude/passsystem-implementation-h1i74q` ([PR #1](https://github.com/aleksacavic/PassSystem/pull/1)). **Result: R13-01 and R13-02 are fixed; one Low follow-up finding, no new major deployment blocker established.**

Only this report is committed, on the separate `codex/passsystem-review-14` branch. Application source, tracked tests, manifests, migrations and Edge Functions were not changed. Additional probes used real React components/router with mocked API boundaries and ignored local artifacts. No production service, Expo/React Native, separate server or Docker infrastructure was used. Supplied production deployment and CI results were not independently queried.

## R13 findings - fixed? yes / no / partly

| Finding | Fixed? | Evidence |
| --- | --- | --- |
| R13-01 — departed registration redirects the guest | **yes** | Back → late success stays on Home; another event link → late success stays on that event's empty form. Both retain the first event's pass in device storage. `savePass` precedes the liveness check; navigation, catch UI changes and `setSubmitting` respect the initiating form's liveness. |
| R13-02 — dismissed attendee action closes the replacement dialog | **yes** | For revoke, restore and reissue, A → confirm → Cancel → open B → A succeeds leaves B open and unconfirmed, with no request for B, and still calls the refresh callback. Supplementary rejection cases for all three operations leave B alone and do not show A's error in B. Modal keys and per-instance `useIsCurrent` keep the identities separate. |

`onDone()` intentionally precedes the modal liveness check. It refreshes the captured attendee list and parent summary after a successful mutation even when its dialog was dismissed. Changing event IDs still discards the entire EventDetail/tab state tree, so these callbacks do not take ownership of the replacement event. A failure does not call `onDone`; the “in any case” source comment should be read as regardless of dialog liveness on success, not regardless of request outcome.

Closing a pending dialog still does not cancel a server operation. In particular, a pending reissue may finish after dismissal and its new credential is not shown in a departed dialog; an organizer may need another deliberate reissue to recover a shareable credential. That is an existing operational consequence, not a new wrong-person operation introduced by this patch.

## Did slug keying change anything a guest relies on?

| Behavior | Assessment |
| --- | --- |
| Retry after network failure on the same event link | **Preserved while that form instance remains active.** `requestId` remains a ref, not a slug/reload-dependent value. The existing retry test passes. An additional probe changes only the same slug's query string while the request is pending, rejects it, then retries: input and requestId are retained. |
| Double tap | **Preserved.** `inFlight.current` is set synchronously before the request; button loading disables additional clicks; `finally` resets the ref even if the initiating component has unmounted. Existing rapid-tap coverage and the extra pending-request probe pass. This is per form instance, not a cross-tab/device/global lock. |
| Terms reload (`reloadKey`) | **Preserved.** It reloads public terms inside the same slug-owned form rather than replacing the form. An extra probe checks retained names and requestId, cleared acceptance, refreshed v2 terms, and a retry sending v2 instead of v1. Changing the slug correctly starts fresh terms/acceptance state. |
| “You already have a pass” (`passesForEvent`) | **Correctly reinitialized for a different slug.** A probe seeds distinct Gala and Spring passes: switching to Spring clears Gala's typed name and shows only Spring's saved-pass link. Previously retained state could belong to the old slug. The list is still a mount-time snapshot, with the late-save gap described in R14-01. |
| Leaving and returning to a link | A new form means a new requestId, empty inputs and a fresh pass-list snapshot. The patch deliberately does not preserve an unfinished attempt across remounts. Same-instance retry idempotency must not be described as durable recovery after leaving/reloading the page. A full route unmount already had that limitation; slug transitions now consistently get their own instance too. |
| Late successful issuance | The completed pass is saved under the captured initiating slug, even if the guest moved elsewhere, but the new page is not forcibly redirected. Storage remains the existing best-effort localStorage convenience; this change does not guarantee persistence when storage is blocked/full or the whole document terminates before the response is handled. |

Changing only query parameters, switching language, and reloading terms do not change `key={slug}`. They therefore do not reset a valid same-link retry merely by rerendering the form.

## New finding

### R14-01 — Low — A pass issued after leaving the form is invisible in an already-open pass list

**Status:** verified frontend discoverability defect; not credential loss or an authorization bypass.

**Locations:** `src/pages/public/HomePage.tsx:11`, `src/pages/public/RegisterPage.tsx:65`; the newly preserved late-save path is `src/pages/public/RegisterPage.tsx:124`–`135`.

Both Home's `passes` and the registration form's `existing` are initialized from storage once, with no setter/subscription. The R13 fix correctly stops obsolete navigation, but a pass saved afterward does not notify a page that has already read its snapshot.

**Concrete failure scenario, reproduced with real pages and deferred mocked registration:**

1. Open `/e/gala`, enter valid names, submit and keep the response pending.
2. Go Back to the real HomePage before it succeeds. Home mounts while the pass store is empty.
3. Complete the successful registration response.
4. The route correctly remains `/`, and `passesForEvent('gala')` contains the new token. **Home still offers no link to that pass.**

The same failure occurs if the guest goes Gala → Spring → Gala before the original response finishes: the new Gala form's existing-pass list stays empty. Navigating away and back afterward exposes the stored pass. The mocked event date was set safely in the future so retention expiry did not cause the missing link.

**Impact:** a guest who already left may believe registration failed, retry and create an additional registration, or need staff help to find their credential. The database and local credential are not lost; refresh/remount is a workaround. There is no obsolete redirect anymore, so this is a smaller follow-up than the corrected R13 behavior, not grounds to undo that fix.

**Suggested fix:** make saved-pass readers reactive to `savePass`/`forgetPass`, for example through a small shared store/subscription hook or `useSyncExternalStore`. Emit a same-document change notification as well as handling the browser `storage` event for other documents; a localStorage write does not fire `storage` on its own writing document. Refresh Home and the matching slug's existing-pass list without navigating or populating another event's form. A simple render-time read alone is insufficient if nothing triggers a rerender.

**Suggested regression test:** mount the actual Home route, submit from Gala, navigate Back, resolve registration, then assert:

```tsx
expect(router.state.location.pathname).toBe('/')
expect(passesForEvent('gala').map(p => p.token)).toContain(result.token)
expect(screen.getByRole('link', { name: /Ana Test/ })).toHaveAttribute(
  'href', `/pass#${result.token}`,
)
```

The final assertion currently fails. Add the Gala → Spring → Gala late-success case, plus a control that a saved Gala pass never appears as Spring's pass. The review probes explicitly assert the current missing link and its recovery after remount; their passing result demonstrates the defect, not a fix.

## Independent validation

| Check | Result |
| --- | --- |
| `npm ci` | Passed with the unchanged lockfile |
| Typecheck / lint | Passed |
| Unit/component suite | **137/137 passed**, 27 files |
| Extra same-link retry/query, terms reload and per-slug pass-list controls | **3 passed** |
| Extra late-save list reproductions (Home and return to same slug) | **2 reproduced**; token stored, route retained, link missing until remount |
| Extra dismissed-modal rejection controls | **3 passed**, revoke/restore/reissue |
| Production build | Passed using CI-style placeholder public Supabase configuration; no server started |
| Bundle-secret scan | Passed, 19 generated files checked |
| Integration / browser E2E | **Not rerun in this environment.** No existing local Supabase API/DB was reachable on the standard local ports. No stack or server was started under the stated infrastructure restriction. The supplied 138/138 integration, 9/9 E2E and green-CI results remain author-reported evidence. |
| Production deployment / migrations / Edge Functions | Not queried or modified |

The extra eight probes used ignored `tests/.artifacts/review14/` fixtures, with no application edits. They exercise the actual registration/Home/modal components and mock API boundaries, not real registration, revocation or reissue.

### Sensitivity of the submitted regressions

In ignored historical component fixtures, restored the literal RegisterPage and AttendeesTab implementations from **06867ed** (the code before d87659e), leaving the current test files and other modules in place. The two targeted files produced **4 failed / 11 passed**:

- Both new registration schedules redirected to `/pass` instead of `/` or `/e/spring`.
- Revoke and restore removed B's dialog; each failed when the test could no longer find that dialog.
- Reissue passed on both versions, as the handover says; it remains a control, not evidence of a newly repaired closing path.

These failures were behavioral assertions, not missing imports/methods. The actual checkout's application files were never replaced. The full current-code suite passed separately.

## Readiness and owner actions

**A supervised single-event deployment/use remains reasonable.** The R13 fixes do what they claim in the exercised schedules, preserve the listed same-link guest behaviors, and introduce no new major blocker established by this scoped review. R14-01 is a worthwhile small follow-up, with refresh/remount as a workaround; I would not hold the supervised event merely to reach zero findings.

For a larger, multi-event, public rollout, I would still require the following operational evidence before calling it ready:

1. **A real-device/venue rehearsal:** iOS Safari and Android Chrome, camera permission recovery/manual entry, registration, pass reopening, duplicate scan and wrong-event rejection, on the actual HTTPS deployment and expected venue network. These frontend tests do not establish camera/network readiness. No offline admission is promised.
2. **A credible public-abuse and peak-load plan:** independently verify the deployed client-IP trust/forgeability assumptions rather than treating the local integration proxy test as proof about Supabase Cloud. The repository still records that live verification as outstanding. Exercise expected shared Wi-Fi/NAT traffic and capacity behavior. For unsupervised public registration, add an effective challenge/abuse mechanism or explicitly justify an alternative; high best-effort IP limits alone do not establish resistance to deliberate slot exhaustion. This is a wider-rollout acceptance gate, not a newly demonstrated exploit in d87659e.
3. **Normal release validation:** retain independent integration/E2E coverage against the existing controlled stack and review deployment provenance. This round did not rerun those suites or verify the stated production deployment, migration state or Edge Function versions. No new multi-event wrong-record mutation was established in this frontend diff; earlier repaired editor/detail ownership is not reopened by the two changes here.

Owner follow-up: arrange that venue rehearsal; complete the deployed IP-header/abuse checks; tell staff that leaving a pending operation does not cancel it and that refresh/reopening can reveal a late-issued pass; keep a deliberate reissue/recovery procedure. If general Google Wallet saving is part of the public promise, resolve the separately documented demo-mode/publishing restriction. Have attendance terms reviewed through the appropriate legal process, as already recorded in the repository. None of these live or legal checks was performed by this review.
