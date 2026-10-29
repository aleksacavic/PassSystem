# PassSystem verification review 15

Reviewed **a856d31..47731bf**, including frontend change **26b1109**, on `claude/passsystem-implementation-h1i74q` ([PR #1](https://github.com/aleksacavic/PassSystem/pull/1)). **R14-01 is fixed. No new major deployment blocker established; one Low retention-cache finding.**

Only this report is committed. Application code, tracked tests, migrations and Edge Functions were not changed. Additional functional probes use ignored local fixtures; no production service or secrets were accessed. No Expo, React Native, separate server or Docker infrastructure was introduced or changed. Supplied production deployment information was not independently queried.

## R14 findings - fixed? yes / no / partly

| Finding | Fixed? | Evidence |
| --- | --- | --- |
| R14-01 — a late-issued pass is invisible in an already-open pass list | **yes** | Home and RegisterPage subscribe to the shared saved-pass store. A successful registration saved after Back appears on Home without redirecting. Gala → Spring → Gala receives the late pass on the fresh Gala form, with empty inputs; Spring does not list Gala's pass. Same-document writes notify directly; other-document storage changes notify subscribers. |

The store fixes discoverability without undoing the earlier registration lifecycle guard: the initiating request still saves its issued credential, while a departed form cannot take over the current route. Matching by slug remains explicit.

## New finding

### R15-01 — Low — Cached passes survive their retention deadline until the stored string changes

**Location:** `src/lib/passStorage.ts:80`–`91`, especially line 90; the time-dependent filter is `src/lib/passStorage.ts:21`–`24`.

**Concrete failure scenario, reproduced with the real hook and a controlled clock:**

1. Store a pass whose event starts at `2030-01-01T00:00:00Z`.
2. At `2030-01-03T23:59:59Z`, mount a subscriber. It correctly returns that pass. Unmount it without changing storage.
3. Advance time to `2030-01-04T00:00:01Z`, past the three-day retention cutoff, and mount a new subscriber in the same document.
4. `loadPasses()` now returns `[]`, but `useStoredPasses()` still returns the cached pass because the raw stored string is identical. Thus navigating back to Home can still show an entry the direct reader now filters out. A rerender or matching storage notification with the same raw value also cannot invalidate it.

Previously a newly mounted Home/form ran the time-dependent reader again. The new module-level cache survives those mounts. Entries already expired on the first read of a changed stored string are still correctly filtered; the defect concerns crossing the cutoff after caching.

**Impact:** stale convenience links and inconsistent retention/list behavior, not renewed pass validity, authorization or admission. The retention cutoff is a local housekeeping rule, not a server credential-expiration guarantee. A document reload or a write that changes the stored string refreshes the cache.

**Suggested fix:** include the next retention deadline in cache validity. Reuse the array while raw storage and the visible result remain unchanged, but recompute when that deadline passes. Notify subscribers at the deadline, or on an appropriate visibility/focus refresh, so a mounted list also updates. Preserve snapshot identity when the filtered contents have not changed; returning a fresh array on every snapshot would violate `useSyncExternalStore` requirements.

**Regression test:** use the schedule above and assert that the newly mounted hook returns `[]`; also check an already-mounted subscriber after its expiry notification. The review probe currently asserts the observed stale result to establish the defect; its passing result is not a claimed fix.

## Store assessment and remaining readers

| Area | Assessment |
| --- | --- |
| Snapshot stability | Same raw value returns the same array on repeated snapshots and rerenders; no render loop observed. Changed writes recompute. The constant server empty array is stable. Time-dependent invalidation is the exception in R15-01. |
| Same-document writes | `savePass` and `forgetPass` notify after attempting the write. Successful save and removal update mounted subscribers in the probe. A failed write does not fabricate successful persistence. |
| Cross-document changes | A matching-key `storage` event rereads storage; a null-key event handles clear. Both update mounted subscribers in the probe. Synthetic storage events exercise the handler, not a real two-browser-tab run. |
| Listener lifetime | The same callback added to the local listener set is removed on cleanup, and the matching window storage handler is removed. Mount/unmount assertions passed; subscribe is module-scoped and stable. |
| Malformed JSON / non-array JSON | Parsing/read exceptions and non-array values return an empty list. Malformed JSON produces a stable empty snapshot. |
| Blocked storage | Read and write exceptions are caught. A blocked-storage probe can mount, save and rerender without throwing or claiming a stored pass. This remains best-effort persistence: blocked/full storage can prevent later recovery of a late-issued pass after leaving; the patch does not add a durable or in-memory fallback. |
| Malformed entry shapes | **Existing limitation, not introduced by this diff:** `loadPasses` validates only a truthy entry and string `token`; it does not validate all `StoredPass` fields. A probe confirms an entry with an object-valued `eventName` is accepted. Home renders that field directly, so arbitrary corrupted but parseable storage is not comprehensively safe. Validate the full record shape if hardening this convenience store; do not describe it as a schema-validating decoder. There is no demonstrated normal application writer producing that shape. |
| Expired entries | Initially expired passes are filtered on a fresh raw value, confirmed by a clock-controlled probe. Crossing the cutoff with an unchanged cache fails as above. Unparseable dates remain retained by the unchanged `current` implementation. |
| PassPage | `src/pages/public/PassPage.tsx:55`–`57` still initializes `storedHere` with a one-time `loadPasses()` read. Its own Forget handler (lines 333–336) removes storage and clears the local flag; `pass_not_found` also calls `forgetPass` (line 75), notifying Home/form subscribers. Its badge/Forget availability does not react to another tab adding or removing the token. This is an unchanged cosmetic snapshot, not the authoritative pass status or an additional list-discoverability failure. The API refresh still determines pass status. |
| Other readers | Search of all `src/` finds no other production saved-pass list snapshots. `passesForEvent` remains an exported imperative helper that reads fresh data on each call, used by tests; neither Home nor RegisterPage uses it as mount-only state anymore. `savePass`/`forgetPass` deliberately perform fresh read/modify/write operations. |

Cross-tab notification does not make localStorage read/modify/write atomic: simultaneous writes by separate tabs can still overwrite each other's lists. That is an inherited convenience-storage limitation, not a concurrency guarantee added by this subscription patch. Direct same-document writes bypassing the helpers likewise do not generate the helpers' notification; repository production writers use the helpers.

## Independent validation

- Typecheck and lint: **passed**.
- Full unit/component suite: **140/140 passed**, 27 files.
- Five additional hook probes: **passed**. They cover identity, save/removal, matching-key and clear notifications, listener cleanup, malformed JSON, blocked storage, initial expiry filtering, the inherited entry-shape limitation and the R15-01 reproduction.
- Sensitivity: in an ignored historical fixture, restored the literal `passStorage`, HomePage and RegisterPage implementations from **d87659e**, retaining the current regression tests. All **three new R14 regression tests failed** on missing expected pass links; 12 unrelated tests were deliberately skipped by the name filter. No missing-module or missing-method failure was counted. The current full suite passed separately.
- Integration against the existing local Supabase stack: **138/138 passed**, 15 files. The first attempt could not write the CLI telemetry cache under the sandbox; rerunning with the required local cache access passed. Standard suite setup temporarily adjusts local test rate limits and restores their defaults; no production settings or infrastructure were changed.
- Browser E2E: not independently rerun. The supplied **9/9** and green CI remain author-reported evidence. No separate server was started under the stated constraint.

The probes are in ignored `tests/.artifacts/review15/`; historical code was exercised under `/tmp/passsystem-review15-before`, without replacing checkout application files.

## Readiness

**Reasonable to deploy/use for the intended supervised event, after a real-device venue rehearsal.** R14-01 is repaired and the remaining Low retention/list issue is a follow-up; I would not delay that event solely to reach zero findings. This scoped frontend review establishes no new major blocker.

As in review 14, a larger unsupervised public rollout still needs operational evidence: actual iOS/Android camera and recovery testing over HTTPS on the venue network; expected shared-network/peak-load testing; and validation of deployed client-IP trust plus a credible public-registration abuse plan. These remain separate from chasing small UI findings. Retain integration/E2E release checks, staff recovery procedures and an explicit decision about any documented Google Wallet demo/publishing restriction. This review did not certify the live deployment or perform those operational checks.
