# PassSystem verification review 8

Reviewed **d468456**, changes **056b9e3..d468456**, on 29 October 2026. `ac9a9ca` contains the remediation; `d468456` records deployment. **Result: one Low finding.** The three review-7 fixes pass their original reproductions and the additional lifecycle/TOML checks. The remaining finding concerns conditional Vercel header-rule coverage in the test checker.

Only this report is committed. No application or deployment source was changed. Historical copies, mutation fixtures and probes were isolated in `/tmp` or ignored artifacts. All suites used the existing local Supabase stack; production, hosted project configuration and production secrets were not accessed. Public vendor schema source was consulted to validate the Vercel rule syntax. No migration or Edge Function changes are included in this remediation. The newer remote event-card commit `6e7af0f` was preserved but is outside this review.

## Finding

### R8-01 — Low — Conditional Vercel rules are treated as unconditional header coverage

**Location:** `src/lib/securityHeaders.test.ts:26–36`, especially the source-only matcher at line 34.

`vercelRules()` reads only `source` and `headers`, silently ignoring the supported `has` and `missing` request conditions. Required headers can therefore become conditional while the checker continues to assert that every ordinary route receives them.

**Concrete reproduction:** In an isolated copy of `vercel.json`, add this property to the existing application-wide security-header rule:

```json
"has": [{ "type": "header", "key": "x-review8", "value": "present" }]
```

Leave its `source` and header values unchanged. `vitest run --project unit src/lib/securityHeaders.test.ts` reports **7 passed**. Under that rule, an ordinary request without `x-review8: present` no longer matches the rule, so the repository's security headers are not supplied by it. The checker still counts it as matching.

A separate mutation with `"missing": [{"type":"header","key":"x-review8"}]` also passed all seven tests, although requests carrying that header would lack the global rule's protection. These fields are supported by the public Vercel [headers schema](https://github.com/vercel/vercel/blob/main/packages/routing-utils/src/schemas.ts), not malformed JSON or unknown deployment properties.

This is a verified checker gap. The checked-in deployment rule is unconditional and remains correct; no mutated configuration was deployed and no hosted response was probed.

**Suggested fix:** For required baseline security headers, require unconditional coverage and fail closed on unmodeled request conditions. Alternatively, retain `has`/`missing` in the rule model and verify both matching and nonmatching request contexts. Add the two mutations above, including conditional rules intended to supply otherwise missing headers.

## R7 findings – fixed? yes/no/partly

| Finding | Fixed? | Verification |
| --- | --- | --- |
| R7-01 | yes | Late decodes after Stop, hide, unmount and replacement deliver nothing. The original real-ScanPage probe now dispatches no admission after Stop. An additional 500-ms fake-clock check showed no extra decode loop attached to a replacement start. |
| R7-02 | yes | Torch success and rejection check both start generation and active track. Original reproductions and the added Stop/hide/unmount/replacement matrix pass. |
| R7-03 | yes | The real TOML parser recognizes the original quoted-key/literal-string cases and additional escaped, dotted, multiline, array and inline-table forms. Unsupported value types fail instead of being omitted. R8-01 is a separate Vercel condition-modeling issue. |

## Camera verification

### Decode results and loop scheduling

All eighteen checked-in hook tests pass, including the four late-decode cancellation/replacement cases. Both new real-ScanPage tests pass: a result after Stop dispatches no admission, while the same result during a running session dispatches exactly one admission. The original independent hook and real-ScanPage probes from review 7 were rerun against current code and now pass as well.

An additional timed probe began decode A, started replacement camera B and its decode, then resolved A. Advancing fake timers by **500 ms**, beyond the 120-ms interval, left the detector call count at **two** and delivered no old result. Thus the old promise's `finally` did not attach another loop to B. This checks actual scheduling, beyond an immediate count assertion before a timer could fire.

### Torch completion matrix

Eight additional combinations covered resolution and rejection across Stop, hide, unmount and replacement. They passed: no stale resolution enabled torch state, and no stale rejection changed the current stream's support state. The replacement tests exercise different stream/track objects. Unmount state assertions alone are weak evidence because React may discard post-unmount updates; source inspection establishes that generation/track checks precede both setters. Hardware constraints and promise timing were mocked; no physical torch/device behavior was tested.

### ScanPage admissions already in flight

This differs from delivering a **new decode after Stop**. An admission already dispatched before Stop is an existing server operation and may legitimately finish; stopping media cannot revoke a committed admission or guarantee cancellation of an HTTP operation.

Three additional real-ScanPage/real-hook tests with a deferred mocked API passed:

1. Dispatch an admission, press Stop, complete the existing request: one API call total; its result is displayed on the still-mounted scanner.
2. Dispatch for event A, navigate to event B, then complete A: one API call total; B remains displayed and A's result does not populate B's scanner/history. The event-keyed scanner instance provides separation.
3. Dispatch, leave/unmount the page, then complete: no second admission is dispatched and no result is rendered on the departed page.

ScanPage does not abort or generation-fence its already-dispatched `submit()` promise. Its completion can still execute feedback and, for a success, refresh the old event before updating the old component's state. This review does not claim those callbacks are cancelled. The verified boundary is no new admission or result leakage into the replacement keyed scanner; the original request remains scoped to its original event and subject to backend authorization. A future policy to suppress completion sounds after navigation would require a mounted/session guard, without pretending to undo the backend admission. These probes mocked API outcomes and did not consume live passes.

## Last sweep: every asynchronous hook boundary

| Boundary in `src/scanner/useCameraScanner.ts` | Guard / effect |
| --- | --- |
| Decode invocation, lines 69–79 | Checks `runningRef` and captured start generation before using the current detector/video. |
| Decode `.then`, lines 80–83 | Rechecks the same live predicate before delivering values. Iteration is synchronous; the current ScanPage callback does not reentrantly stop the hook between values. |
| Decode `.catch`, line 84 | No state, acquisition or result side effect. |
| Decode `.finally(next)`, line 85 | `next` checks the captured generation and running state before scheduling. |
| Timer scheduling and callback, line 75 | Scheduled callback carries its generation and re-enters the live check. Stop/cleanup also clears the recorded timer. A previously queued stale callback cannot decode or reschedule. |
| Media promise fulfillment/rejection, lines 115–121 | Fulfillment tracks a current stream immediately or stops a stale stream; rejection callback has no side effect. Pending streams are included in cancellation cleanup. |
| `await Promise.all(detector, media)`, lines 123–124 | Checks generation before assigning stream/detector or mutating state/video. |
| `await video.play().catch(...)`, lines 134–135 | Playback rejection handler is a no-op; generation is checked after settlement before subsequent mutations. Cancellation already stops/detaches the stream. |
| Startup `await enumerateDevices()`, lines 143–149 | Only a local `cameras` variable changes before the generation check; state/loop startup follow the check. |
| Startup `catch`/`finally`, lines 153–179 | Stale catch exits; current failure advances generation and stops all owned streams. Finally clears `startingRef` only if it still belongs to this start. |
| Torch `await applyConstraints`, lines 202–205 | Success and rejection both check generation **and exact active track** before setting state. |
| Switch `await enumerateDevices`, lines 214–220 | Checks generation and visibility before choosing a device/opening another camera. The subsequent `await start()` has no mutating continuation. Switch catch is a no-op. |
| Visibility event's asynchronous start, lines 228–239 | Hide invalidates current work and releases tracks; visible resume is conditional on the resume flag and visible state, then uses the fenced start path. Listener cleanup removes future visibility callbacks. |
| Unmount cleanup, lines 245–252 | Synchronously invalidates generation, clears startup/running ownership and stops active/pending streams; all captured continuations then fail their ownership checks. |

The hook's effect updating `onDetectRef` and the effect installing `loopRef` are synchronous ref updates, not extra scheduled loops. Explicit `start()`/Stop/visibility operations have their intentional synchronous state effects. No remaining asynchronous camera-opening, result-delivery or track-state continuation bypass was established in the current application's hook paths.

## Header parsing verification

`npm ci` installed the lockfile successfully. `smol-toml` is exactly **1.9.0** in the manifest/lockfile and is a dev dependency used by the test checker. It does not add a guest/browser runtime parser.

In isolated deployment copies, the checker rejected scoped CSP conflicts expressed as:

- Quoted keys, single-quoted literal values and mixed casing.
- An escaped key (`CoNtEnT\u002dSeCuRiTy-PoLiCy`), multiline strings and dotted `values` keys.
- A string array containing a conflicting policy, and a `values = {...}` inline table.

Numeric header values, nested arrays and object-valued header fields failed with the unsupported-value error rather than disappearing from the check. This is appropriate failure for unsupported header values, not a claim that those are valid hosting header configurations. No tested TOML syntax form hid a scoped override after parsing.

The Vercel JSON parser also rejected an ordinary mixed-case scoped override. JSON decoding and field-name normalization retain those fields. The conditional baseline-coverage mutations instead passed, producing R8-01. The checker remains a conservative policy validator over sampled paths, not a complete hosting-platform emulator; no hosted duplicate-header behavior was inferred from it.

## Test execution

Ran the requested **`npm run test:all`** against local Supabase after `npm ci`:

| Check | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Unit | 108/108 passed, 21 files |
| Integration | 127/127 passed, 13 files |
| Default Playwright | Nine launch failures: configured `chromium_headless_shell-1243` executable absent |
| Complete browser suite using installed `/usr/bin/chromium` and ignored configuration | 9/9 passed, 58.3 seconds |
| Independent original review-7 hook/page probes | Passed: two hook cases and one real-page case |
| Additional timed/torch matrix | 9/9 passed |
| Additional in-flight ScanPage cases | 3/3 passed |

The default command did not exit successfully as written because of the missing browser executable. The fallback ran after that process exited and passed the complete browser suite. No production check or deployment was performed.

## L/M sensitivity

**L** restores the literal previous hook or checker helpers in an isolated source copy while keeping current tests. **M** means a focused faulty-behavior mutation preserving today's API; no M substitution was needed for this round's nine new checked-in tests. Missing imports, malformed fixtures and infrastructure errors were not counted as sensitivity.

| New test(s) | Pre-fix result | Classification |
| --- | --- | --- |
| Four hook decode cases: Stop, hide, unmount, replacement | L: `056b9e3` hook. All four failed no-result assertions. | Finding reproductions |
| Two hook torch cases: Stop success and replacement rejection | Same L hook. Both failed the intended state assertions. | Finding reproductions |
| Real-ScanPage late decode after Stop | Same L hook, real current page, mocked hardware/API. Failed because admission was dispatched. | Finding reproduction |
| Real-ScanPage running-session admission control | Passed with the same old hook. | Invariant/control; expected to work before and after |
| New quoted-key/literal-string checker test | L: literal `056b9e3` checker helpers with the new test appended. Failed the scoped-policy assertion. | Finding reproduction |

The combined historical hook/page run produced **7 failed / 13 passed**: seven new finding reproductions failed; the twelve older hook tests and new positive control passed. The historical checker run produced **1 failed / 6 passed**. The multi-assertion header test stops at its first failed historical assertion; the additional current-code syntax matrix separately verifies all listed forms. The immediate checked-in decode counts alone do not establish timer suppression, which is why the independent timed replacement probe was added.

All counterfactual source and configuration edits were confined to isolated copies. No local database functions were mutated in this round, and no reproduction/test file is included in the commit.
