# PassSystem verification review 7

Reviewed **0c04760**, changes **bc10544..0c04760**, on 29 October 2026. `aed365a` contains the remediation; `0c04760` records deployment. **Result: one Medium and two Low findings.** The original late-switch restart and ordinary case-varied header override are repaired, but other asynchronous camera callbacks and valid TOML variants remain uncovered.

Only this report is committed. Application and deployment files were not changed. Historical copies, mutation fixtures and probes were isolated under `/tmp` or ignored artifacts. The suites used the existing local Supabase stack; production, hosted configuration and production secrets were not accessed. No migration is introduced by this round.

## Findings

### R7-01 — Medium — A decode completing after Stop can still submit an admission

**Location:** `src/scanner/useCameraScanner.ts:74–80`, especially line 77; downstream `src/pages/scan/ScanPage.tsx:172–185`.

The decode promise delivers its results without checking the captured camera generation or whether the scanner is still running. Stopping tracks does not cancel an already running decoder. The callback uses the current `onDetectRef`, so an old result can also reach a newer session's handler. Its `finally(next)` can schedule work for a replacement session if `runningRef` has become true again.

**Concrete reproduction:** With the real hook, mounted video and deferred detector result:

1. Start successfully and let `detect(video)` begin on an available frame.
2. Call Stop before that promise settles.
3. Resolve the detector with a valid pass token.

Observed: `onDetect` was called once after Stop; the expected count was zero. A second probe rendered the **real ScanPage with the real hook**, mocked camera/detector and API boundary, clicked Start camera then Stop camera, and only then resolved the decode. It recorded one `admitPass('event-one', token, attemptId)` call, failing the no-admission-after-Stop assertion. The mocked API returned an admission response; no real pass was consumed by this probe.

This does not bypass server authorization or single-use admission rules. It permits an unintended admission request after the operator has stopped scanning. The continuation predates this remediation but is within the requested search for remaining callbacks after cancellation.

**Suggested fix:** Capture the generation and detector/stream ownership when beginning each decode. Discard results unless that same generation remains running, and apply the same check before scheduling the next iteration. Ensure an old decode cannot attach an extra loop to a replacement start. Add deferred-decode tests for Stop, hide, unmount and session replacement, including a ScanPage assertion that no admission is dispatched.

### R7-02 — Low — A stale torch operation changes state after cancellation

**Location:** `src/scanner/useCameraScanner.ts:188–197`.

`toggleTorch()` captures a track, awaits `applyConstraints()`, then changes state without checking that the track and generation are still current. Its rejection path can likewise clear support for a newer stream.

**Concrete reproduction:** Start the real hook with a torch-capable mocked track; defer `applyConstraints()`. Begin toggling the torch on, call Stop, then resolve the constraints operation. Stop resets `torchOn` to false, but the old continuation sets it back to **true**. The additional local test failed with `true` instead of `false`.

This establishes stale UI state, not reactivation of the physical stopped camera. During stream replacement, the same pattern can describe the old track's torch state as the new track's state or disable the new track's torch controls.

**Suggested fix:** Capture generation and track ownership before awaiting constraints, and check both before changing `torchOn` or `torchSupported` in success and failure paths. Test resolution and rejection across Stop, hide/unmount and replacement streams.

### R7-03 — Low — Valid TOML header syntax is silently omitted by the checker

**Location:** `src/lib/securityHeaders.test.ts:49–53` (`netlifyRules` header-value regex).

Lowercasing now handles the fields that the regex recognizes, but the regex only recognizes bare keys with double-quoted values. TOML also allows quoted keys and single-quoted literal strings. A valid additional scoped security field in either form is ignored, leaving only the approved global value in the checker's map.

**Concrete reproduction:** Append either block independently to an isolated copy of the checked-in `netlify.toml`:

```toml
[[headers]]
for = "/scan/*"
[headers.values]
"content-security-policy" = "default-src *"
```

Or use the same block with:

```toml
content-security-policy = 'default-src *'
```

For **each** mutation, `vitest run --project unit src/lib/securityHeaders.test.ts` reports **6 passed**. The corresponding bare-key/double-quoted override is rejected. The quoted-key block is valid TOML and describes a duplicate HTTP field across matching global/scoped rules; no malformed configuration is required.

This is a verified regression-checker gap. The checked-in Netlify policy remains correct, and no mutated configuration was deployed. Host-specific handling of multiple CSP fields was not tested; the checker expressly intends to reject every conflicting value regardless of host combination behavior, and fails to see these values at all.

**Suggested fix:** Parse TOML with a conforming parser, preserve each header block and normalize its parsed keys. If intentionally supporting only a subset, reject unsupported header syntax rather than silently ignoring it. Add quoted-key and literal-string overrides, including mixed casing, to the mutation tests.

## R6 findings – fixed? yes/no/partly

| Finding | Fixed? | Verification |
| --- | --- | --- |
| R6-01 | yes | The specific delayed `switchCamera` continuation is fenced after Stop/hide/unmount and after a normal start. Overlapping switches open only one replacement camera in both completion orders. Other callback types still lack cancellation checks: R7-01 and R7-02. |
| R6-02 | partly | Recognized fields are case-insensitive, duplicate values are retained, and ordinary scoped/case-varied conflicts are rejected. Valid TOML representations can still be ignored entirely: R7-03. |

## Checks found sound

### Camera switching and startup ownership

All twelve checked-in camera tests pass. They include the original running→Switch→Stop schedule, switch across hide, switch across unmount, and overlapping switches with the newer enumeration completing first. The original three startup schedules from review 5 remain covered and pass.

Three additional local switch tests also passed:

- A pending switch followed by a normal `start()` is dropped when its enumeration arrives; only the initial and normal-start media requests occur.
- After unmount, a pending switch opens no media and does not request another detector, even when any subsequent detector initialization has been arranged to remain pending. There is no new post-unmount stream to leak through that path.
- Two overlapping switches resolving **older first** still open only one new camera; the second enumeration is discarded after the first starts a new generation.

The last case refines the wording at `AUDIT_REMEDIATION.md:175`: merely calling a newer switch does not increment the generation. Of two pending switches, the first enumeration that proceeds to `start()` wins; the checked-in test demonstrates the newer one winning only because its enumeration resolves first. This does not recreate the unwanted extra-camera acquisition, but the documentation should say “a switch that starts a replacement advances the generation,” rather than imply latest-invocation priority.

Hardware and decoder timing were mocked for these ordering probes; no physical-device camera claim is made. R7-01/R7-02 are separate callbacks outside the repaired switch continuation.

### Header normalization and duplicate handling

An isolated mutation matrix exercised scanner, assets and `index.html` rules for both providers. Conflicting case-varied values and empty values were rejected on the sampled routes. Vercel duplicate fields within a rule were tested with the bad value before and after the approved value; conflicts were rejected in both orders. A bad scoped value followed by another approved rule was also rejected, so last-write-wins no longer hides the conflict. A case-distinct duplicate in a Netlify values block was rejected when expressed with the supported syntax.

Across twenty initial variants, nineteen deliberately invalid/conflicting policy checks failed as expected; the one invariant case—an identical approved duplicate—passed all six tests. Removing the global Vercel CSP also failed. The two additional valid-TOML syntax variants both passed unexpectedly, producing R7-03.

The checker deliberately requires every collected value to equal the approved value. That conservative test policy avoids depending on override/append behavior, but is not an emulation of either hosting platform. Route coverage remains the explicit sampled PATHS list. No hosted response or deployment was accessed.

### Documentation: locks and lease lifetime

The corrected lock explanation at `AUDIT_REMEDIATION.md:180–185` accurately identifies why the relevant same-target operations serialize despite generation/profile ordering differences:

- `set_pending_admin` and confirmation both hold the target Auth-row lock before their conflicting profile/generation operations. The setter additionally acquires the admin lock first; “both start with the Auth row” should be read as the first shared serialization point, not identical literal first operations.
- The setter and `set_user_admin` serialize through the admin advisory lock before the reverse-order pair can be held concurrently.
- Confirmation and demotion take profile→generation in the same order. `begin_invite` and `end_invite` only take a generation-row lock and introduce no reverse dependency on Auth/profile.

This is an argument about these application paths, not a proof for arbitrary owner-written transactions. The note explicitly supersedes the inaccurate applied-migration comment rather than suggesting migration 010 changed. No database functions or locks changed in this remediation, and the full integration suite passed.

The lease note at lines 186–189 correctly states the 600-second exclusion assumption, the documented 150/400-second Edge wall-clock bounds, and the separate uncertainty around an already-dispatched Auth operation surviving worker termination. It accurately requires reevaluation for self-hosting, changed limits or queued/retried work. The preceding R5-01 entry now explicitly limits the generation fence to **roles**, not external token replacement. These corrections address the preceding review without claiming that downstream cancellation was proved. Production runtime limits were not inspected.

## Test execution

Ran the requested **`npm run test:all`** against the existing local Supabase stack:

| Check | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Unit | 99/99 passed, 20 files |
| Integration | 127/127 passed, 13 files |
| Default Playwright | Nine launch failures: configured `chromium_headless_shell-1243` executable absent |
| Complete browser suite with installed `/usr/bin/chromium` and ignored configuration | 9/9 passed, 56.7 seconds |

The default command did not exit successfully as written because of the browser executable. The first fallback attempt overlapped the default runner's preview-server shutdown and failed with connection-refused errors; a clean sequential rerun passed all nine tests. The local CLI required its existing home-cache access, so the complete suite was run with that sandbox access. No production test or browser deployment was performed.

## L/M sensitivity

**L** restores the literal preceding implementation/helpers in an isolated source copy while retaining the new tests. **M** means a focused behavioral mutation preserving current contracts; no M substitution was needed for the five new checked-in tests in this round. Missing imports, fixture errors and browser infrastructure failures were not counted as sensitivity.

| New test | Pre-fix result | Classification |
| --- | --- | --- |
| Switch after Stop | L: `bc10544` hook. Failed its idle/no-new-camera assertions. | Finding reproduction |
| Switch after hide | Same L hook. Failed its idle/no-new-camera assertions. | Finding reproduction |
| Switch after unmount | Same L hook. Failed the no-new-camera assertion. | Finding reproduction |
| Overlapping switches, newer enumeration resolves first | Same L hook. Failed media-request count (extra acquisition). | Finding reproduction |
| Case-varied header override test | L: literal `bc10544` checker helpers with the new test appended. New test failed; the five older tests passed. | Finding reproduction |

The full current camera file against the old hook produced **4 failed / 8 passed**: the eight older tests are invariant guards for this change, not evidence that the switch fix existed before. The header run produced **1 failed / 5 passed**. These outcomes substantiate the remediation's new-test sensitivity claims.

Additional probes intentionally failing against **current** code were the late-decode hook and real-ScanPage tests, and the stale torch-state test. The real-ScanPage probe mocked the API boundary, so its observed failure establishes dispatch after Stop, not a live database admission. The valid-TOML mutations establish missed policy checks. No reproducer or mutation file is included in the commit.
