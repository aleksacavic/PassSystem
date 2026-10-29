# PassSystem verification review 16

Reviewed **2742153..cfb8db5**, including **3542aa9** (attendee toolbar) and **530e1fc** (saved-pass expiry), on `claude/passsystem-implementation-h1i74q` ([PR #1](https://github.com/aleksacavic/PassSystem/pull/1)). **No Critical, High or Medium finding. R15-01 is fixed for the reported schedules. Three Low follow-ups below, including an inherited request-ordering weakness and an unusual clock-change edge case.**

Only this report is committed. Application code, tracked tests, migrations and Edge Functions were not changed. No production service or secrets were accessed. No Expo, React Native, separate server or Docker infrastructure was introduced or changed. Supplied production provenance remains author-reported.

## R15 findings - fixed? yes / no / partly

| Finding | Fixed? | Evidence |
| --- | --- | --- |
| R15-01 — cached lists retain passes after their retention deadline | **yes** | The original before-deadline mount → unmount → after-deadline remount schedule now returns an empty list. An open subscriber drops the first expired pass and retains a later one. The cache checks its next deadline, and an active subscription schedules expiry notifications. The forward clock-change edge below is a narrower residual limitation, not failure of the original ordinary-clock schedules. |

The earlier malformed-entry limitation is also improved: all six fields must be strings. PassPage's saved-here badge and Forget availability now subscribe rather than keeping a mount-only flag. Forget still removes only the device convenience copy; API status remains authoritative.

## Findings

### R16-01 — Low — Search collapses again at the small-screen breakpoint

**Location:** `src/pages/admin/event/AttendeesTab.tsx:109`–`110`, with the fixed-width status/actions at lines 138–165.

**Concrete reproduction:** open Attendees at a **640px** viewport, enter a search so Clear all appears. In an offline Chromium layout probe using the real component's captured markup, freshly built production CSS and self-hosted fonts, the input is only **76px wide**. Its `ps-9 pe-10` consumes that entire width, leaving essentially no room to see or edit the query. The screenshot shows a small icon-and-X control again. At 768px the input is about 135px, still cramped; at 1280px it is about 327px.

The full-width phone fix works below `sm`, but `sm:flex-1` has a zero flex basis and `min-w-0`. Combined with the 192px status control, Clear all, spacer and Export, wrapping does not preserve a usable search minimum at the breakpoint. `sm:flex-wrap` alone does not solve this.

**Suggested fix:** preserve a meaningful search minimum/flex basis and let other controls wrap, or keep the stacked layout until a wider breakpoint. Cover 640–800px with an active query, not only Pixel 7 and desktop. On very narrow phones also allow the status/Export group to wrap before the longest status label is squeezed.

**Impact:** a toolbar usability problem at intermediate widths, not an authorization or attendee-data integrity issue. Phones at 320–430px now get the intended full-width search.

### R16-02 — Low — A response started before Clear can replace the cleared results

**Location:** `src/pages/admin/event/AttendeesTab.tsx:43`–`49`; new Clear paths at lines 95–103.

**Scope:** the unguarded loader predates this diff. The new Clear feature exposes the same request-ordering weakness; this is not a newly introduced cross-event mutation.

**Concrete reproduction, real component with deferred mocked API:**

1. Initially show Bob. Enter `Alice`; let the 250ms debounce issue a request and hold its response.
2. Activate Clear search. The input and debounced query become empty immediately; the new unfiltered request completes and displays Bob.
3. Complete the older Alice request afterward. The input remains empty, but Bob disappears and Alice's filtered rows replace the unfiltered result.

The older response may similarly replace totals/pagination or set an obsolete error. Polling can produce out-of-order responses too. Event ID remounting protects a different event's instance, but does not distinguish requests inside the same mounted tab.

**Suggested fix:** bind each request to the current query/page generation, with a latest-request sequence for requests sharing that generation; discard superseded success/error callbacks. Alternatively cancel superseded requests while retaining an identity check. Test delayed search → Clear → fresh response → old response, and equivalent page/status/poll schedules. Do not treat debounce cancellation alone as cancellation of an already-dispatched query.

**Impact:** temporarily misleading attendee results until a new load/poll; operations still target the explicit row the organizer selects. The probe establishes no wrong-event or wrong-ID mutation.

### R16-03 — Low — Forward clock changes do not wake an already-mounted expiry list

**Location:** `src/lib/passStorage.ts:120`–`128`; subscriptions at lines 83–94 listen only for storage changes.

**Concrete reproduction, real hook with controlled wall clock:** mount at `2030-01-03T23:00:00Z` with a pass starting January 1, so its deadline is an hour away. Move the wall clock forward two hours without advancing elapsed timer time, then dispatch `visibilitychange`. The mounted hook still exposes the pass. Rerendering immediately drops it, proving the snapshot deadline check works but no notification ran.

Browser timeout delays are elapsed-time delays; a wall-clock correction does not necessarily make the original timer immediately due. Until another store notification/rerender or the original remaining timeout, the list can be stale. This differs from an ordinary throttled/sleeping tab whose elapsed timer has actually become due.

**Suggested fix:** notify/recheck on visibility restoration and/or focus, then re-arm against the current wall clock. If correcting while continuously visible must be prompt too, use a bounded periodic check rather than waiting arbitrarily long for a distant deadline. Retain stable snapshots when the displayed contents did not change.

**Impact:** local retention housekeeping after unusual device clock corrections; not server credential validity or an admission bypass. Not a reason to delay a supervised event.

## Toolbar checks

| Area | Result and limits |
| --- | --- |
| 320 / 360 / 390 / 430px | Search widths measured **288 / 328 / 358 / 398px** with 16px content padding each side; separate search row, no horizontal document overflow. Clear all occupies the intended separate line. |
| `sm` and wider | Search/status share a row. The search minimum is inadequate near 640px (R16-01). Desktop 1280px has usable space. These are real-browser layout measurements of captured component markup, not a live application E2E run. |
| Long status text | Native select remains operable, but its width is not guaranteed to fit the longest label. At 320px with Export alongside it, the status control has only about 139px; `Not checked in` competes with the select padding/arrow. A minimum or wrapping the neighboring action is preferable to assuming every label fits. No arbitrary localized admin labels were claimed supported. |
| RTL | Search uses start/end icon placement and logical padding; paired `lang="ar"` / `dir="rtl"` mirrors them in the browser fixture. The compiled CSS lowers logical position utilities to language-based fallbacks for the build target. A preliminary dir-only fixture gave a misleading mismatch and was corrected; it is not an app finding. Guest language handling sets both attributes. The shared Select's existing physical `pr-9` and table alignment are not comprehensive Arabic-admin support. |
| Keyboard / accessible names | Search is a labelled searchbox; status a labelled combobox; X has `aria-label="Clear search"`, is a native type=button, and its icon is hidden from assistive technology. Clear all has visible text. A keyboard probe tabs from search to Clear search and presses Enter successfully. No actual screen reader was run. |
| Clear focus | Clear search unmounts itself after activation without explicitly focusing the input. Restoring focus would make repeated keyboard editing more convenient; no keyboard trap was demonstrated. Both Clear all buttons in an empty filtered view have the same legitimate action. |
| Debounce | Clear immediately empties both search values and resets page. The effect cleanup cancels the old pending 250ms timer; a keyboard-clear-before-debounce probe confirms the old text does not reappear. Already-issued requests remain subject to R16-02. |
| Pagination / polling | A probe moves to page 2, searches, clears and advances the real polling hook: new queries use page 1 and the current cleared filters. The handler resets page on input/status changes. Polling reads the latest callback via ref, skips hidden ticks and runs on visibility return. It neither cancels overlapping requests nor guarantees response order. |
| Empty states | Correct separate no-attendees and no-match messages; filtered empty state offers Clear all. A briefly retained old result while a query loads is possible; this patch does not introduce a loading-state redesign. |

## Saved-pass timer checks

- **Several passes and long waits:** an extra probe starts in January with March/April passes, advances 65 days across the maximum-timeout re-arm boundaries, and retains only the later pass. Timer waits are capped at `2^31-1` ms rather than overflowing into rapid callbacks.
- **Cleanup:** with two subscribers there is one expiry timeout; removing one preserves it; removing the last clears it. The probe drains the unrelated jsdom storage-event task before counting timers. The window storage handlers are also removed by subscription cleanup.
- **Backward clock correction:** a pending callback sees that the deadline is still in the future and re-arms. A probe moving the clock back an hour confirms no premature removal or render loop, then correct removal after the adjusted deadline.
- **Sleep/throttling:** once a due callback is delivered, it compares current time and the snapshot filters all passes now expired, then arms the next deadline. Notifications cannot run while the browser/process is suspended; no immediate background execution guarantee is implied. The controlled long-time advance exercises deadline catch-up, not actual OS suspension. Forward correction without a due callback is R16-03.
- **Snapshot identity:** the submitted test confirms repeated unchanged snapshots reuse the array and a save changes it. Expired entries are removed before the next deadline is selected; the `+1ms` boundary avoids repeatedly waking exactly on a deadline. No render loop observed in these schedules.
- **Malformed/blocked storage:** non-string field shapes are now ignored, and parse/read/write exceptions remain caught. Invalid date strings are still accepted and retained indefinitely by the explicit existing NaN rule; this is not full semantic validation of dates/tokens. The subscription is still best-effort convenience storage, not durable delivery when storage is unavailable.
- **PassPage:** uses the shared hook for `storedHere`; successful removal notifies subscribers, including other documents through storage events. The remaining direct production `loadPasses` reads are inside the store's imperative read/modify/write helpers, not a page-owned mount-only saved-list cache.

## Independent validation and sensitivity

| Check | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Full unit/component suite | **147/147 passed**, 27 files |
| Integration against the existing local Supabase stack | **138/138 passed**, 15 files; no new stack or infrastructure started |
| Extra functional probes | **13 passed** across two ignored files: six existing attendee controls plus seven added timer, lifecycle, keyboard, pagination/polling, stale-response and DOM-capture probes. Reproduction probes assert the observed defect, not a repaired behavior. |
| Production build / bundle-secret scan | Passed using placeholder public build configuration; 19 generated files checked |
| Layout inspection | Installed Chromium, production CSS/fonts and captured real component DOM at seven widths in both language/direction modes; screenshots inspected. No server started. This does not exercise React event handling in the browser. |
| Browser E2E | **Not independently rerun** under the no-separate-server constraint. Submitted **10/10** and CI results remain author-reported. |

Sensitivity used an ignored historical fixture with current tests but literal pre-change `passStorage` from **26b1109** and AttendeesTab from **2742153**. Across the two targeted files: **6 failed / 6 passed**. Failures were the two expiry schedules, malformed-entry filtering, and all three new attendee search/empty-state cases. The original storage tests, snapshot identity control and three earlier attendee-dialog cases passed. Failures were behavioral assertions, not missing imports or methods. The new phone-width E2E regression's historical sensitivity was not independently executed.

Fixtures: ignored `tests/.artifacts/review16/` and `/tmp/passsystem-review16-before`. Integration's standard setup temporarily raises local test rate limits and restores defaults; production settings were not accessed.

## Readiness

**Reasonable to deploy and use for the intended supervised event after a real-device venue rehearsal. No major blocker found in this round.** The original retention fix works, phone search is substantially improved, and the listed Low issues are follow-ups rather than grounds to hold that event merely to reach zero findings. Prioritize the intermediate-width toolbar and request-order guard over the unusual clock-change housekeeping case.

As in review 15, this is not certification of a larger unsupervised public rollout. Retain the iOS/Android camera and recovery rehearsal on the actual venue network, shared-network/peak-load evidence, validation of deployed client-IP trust and a credible public-registration abuse plan. Keep independent E2E release coverage and staff recovery procedures, and resolve any documented Google Wallet demo/publishing restriction if general saving is promised. No live deployment or operational acceptance check was performed here.
