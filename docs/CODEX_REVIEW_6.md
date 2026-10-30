# PassSystem verification review 6

Reviewed **c322d3d** on 29 October 2026, including remediation `ae85b86` and the deployment-record documentation. The application diff is **ad6fcde..c322d3d**. Also inspected the explicitly requested test-only `76750e4`, which is already an ancestor of `ad6fcde` rather than a new commit in that range.

**Result: one Medium and one Low finding.** The original invitation-issuance race is fixed under the documented Supabase Edge lifetime bound. Camera switching still has an uncancelled continuation, and the route-aware header checker still treats header names as case-sensitive.

Only this report is committed. No application source was modified. Local probes and historical copies were ignored/untracked artifacts or `/tmp` files. All database, Auth, and Edge operations targeted the disposable local stack. Production projects, deployments and secrets were not accessed. The provided production state was context only; public platform documentation was consulted separately.

## Findings

### R6-01 — Medium — A pending camera switch restarts acquisition after Stop

**Location:** `src/scanner/useCameraScanner.ts:200–207` (especially the continuation after `enumerateDevices()` at line 202).

`start()` now checks cancellation at its asynchronous boundaries, but `switchCamera()` does not. Its camera enumeration can finish after Stop, hide, unmount, or another start. It then invokes a fresh `start()`, creating a new generation that is no longer cancelled by the earlier action.

**Concrete reproduction:** Use the real hook with a mounted video and mocked camera hardware:

1. Start the scanner successfully, with two enumerated cameras. This makes the UI's Switch camera and Stop camera controls available.
2. Click Switch camera; defer that call's `enumerateDevices()` result.
3. Click Stop camera. The active track stops and status becomes `idle`.
4. Resolve the switch's enumeration with the two cameras. Allow its new `getUserMedia()` and subsequent startup to complete.

Observed before cleanup: **`status:'running', newStreamStops:0`**, instead of remaining idle with the newly acquired stream released. The old stopped stream and the newly acquired stream were distinct objects. A second, simpler cancellation probe reproduced the same restart. These were deterministic hook tests, not physical-camera observations.

The same unguarded switch continuation can invoke `start()` after unmount. In particular, it can acquire a pending stream after unmount cleanup has already run; if detector initialization remains pending, there is no subsequent component cleanup to release it. The verified running→Switch→Stop case is sufficient to demonstrate the cancellation defect without relying on that additional ordering.

**Suggested fix:** Capture an operation generation before switch enumeration and recheck it, mounted state and visibility before changing the selected device or invoking `start()`. Stop, hide, unmount and a newer start/switch must invalidate pending switches as well as pending starts. Add the running→Switch→Stop schedule, a switch pending across hide/unmount, and overlapping switches to the lifecycle suite.

### R6-02 — Low — Scoped header overrides with different casing bypass the regression checker

**Location:** `src/lib/securityHeaders.test.ts:33`, `src/lib/securityHeaders.test.ts:49`, `src/lib/securityHeaders.test.ts:57–58`.

The route-aware checker preserves header-key casing and merges with `Object.assign`. HTTP field names are case-insensitive; `content-security-policy` and `Content-Security-Policy` name the same field. The checker instead retains two independent properties and validates only the capitalized one.

**Concrete reproduction:** In an isolated copy of `vercel.json`, append:

```json
{
  "source": "/scan/:id",
  "headers": [{ "key": "content-security-policy", "value": "default-src *" }]
}
```

Run `vitest run --project unit src/lib/securityHeaders.test.ts`: **5 passed**. Changing only the key to `Content-Security-Policy` makes the suite fail. The same lowercase-key mutation passed for `/assets/(.*)` and `/index.html`; their capitalized equivalents failed.

This is a verified checker defect, not an assertion that the currently checked-in production policy is widened. No mutated configuration was deployed. Whether a hosting adapter overwrites or emits repeated fields must be modeled according to that adapter; silently treating the two casings as unrelated is incorrect either way.

**Suggested fix:** Normalize field names to lowercase when parsing rules, merging effective headers and comparing expected fields. Model duplicate-field semantics explicitly, including scoped rules. Add case-varied override mutations for both providers and retain the existing narrowed-rule and asset/index coverage checks.

## R5 findings – fixed? yes/no/partly

| Finding | Fixed? | Verification / remaining limitation |
| --- | --- | --- |
| R5-01 | yes | Original pre-Auth interleaving now refuses the second invite with 409 and no link; the first link accepts with its intended role. Failure cleanup, concurrency, expiry, demotion and removal/re-invite checks passed. Safety of external issuance remains conditional on the issuer not surviving its lease; see the lifetime analysis below. |
| R5-02 | partly | All three original schedules pass, as do late-camera unmount, overlapping starts and hide/show startup. `switchCamera()` can still resume after cancellation: R6-01. |
| R5-03 | yes | Message keys translate at render time for every field and terms branch. Additional client/server field probes and the original terms-switch probe passed without diagnostic text. General-error translation remains intact. |
| R5-04 | partly | Narrowed sources, conventional scoped overrides and missing policies are detected on the sampled routes, including assets/index.html. Case-varied field names bypass the checker: R6-02. |

## Invitation lease verification

### Original race and failure paths

Ran the actual checked-out handler with its original local Auth/PostgREST calls, gating only A's outgoing Auth request before token issuance. A reserved the address; B returned **409 `invite_in_progress`, no link**; after releasing A, A returned success/admin intent and its link was accepted. This reproduces the original schedule more directly than relying only on the checked-in Auth-row-lock test, which also passed.

Additional local results:

| Scenario | Result |
| --- | --- |
| Auth HTTP 500 | Handler returned 502 `invite_failed`; the next reservation succeeded. |
| Auth `user_exists` HTTP 422 | Handler returned 409 `user_exists`; the next reservation succeeded. |
| Auth rate-limit HTTP 429 | Handler returned 429 `email_rate_limited`; the next reservation succeeded. |
| Auth fetch rejects | Exception propagates, but `finally` releases the lease; the next reservation succeeded. This check concerns lease cleanup, not a new transport-error response contract. |
| Twelve concurrent `begin_invite` calls, same email | Exactly one numeric generation and eleven null/busy results. |
| Abandoned/crashed-request model | Without calling cleanup, an artificially expired lease admitted the next generation. No ten-minute sleep or hosted timeout was used. |
| Stale `end_invite` after expiry/reacquisition | Did not release the newer lease; a third reservation remained busy until the current owner ended it. |
| Demotion during target's in-flight invite | Lease stayed busy until completion; old role save returned `stale`, target remained non-admin, and the lease was released. |
| Removal while invite is in flight | Old user ID returned `not_found`; handler-style final cleanup released the address. Re-inviting the same email created a different user ID; its staff link accepted without admin rights. |

The HTTP failure statuses above were injected into the Auth fetch of the real handler; reservation/release queries remained real local database operations. The successful issuance/acceptance and concurrency cases used actual local Auth. The direct removal probe explicitly called the same final `end_invite` operation used by the handler.

### Ten-minute lifetime assumption

The public Supabase [Edge limits documentation](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/functions/limits.mdx), read during this review, specifies a wall-clock maximum of **150 seconds on Free and 400 seconds on paid plans**, plus a 150-second request-idle timeout. Thus a handler governed by those wall-clock limits cannot itself remain executing beyond the **600-second** lease. A gateway idle timeout is not equivalent to immediate worker termination; the larger wall-clock bound is the relevant comparison. No production plan, runtime override, or hosted limit was inspected.

The generation fence is **not sufficient to protect token issuance if an old issuer does survive its lease**. A local model deliberately expired A's lease while its pre-Auth call remained gated, let B issue/return a link, then resumed A. A returned `409 invite_superseded` without a link, but B's token failed with `otp_expired`. The role fence still worked. This establishes the conditional limitation, not that the documented hosted wall-clock limit can be bypassed.

The lifetime bound must also cover delayed downstream side effects, not merely the lifetime of the JavaScript handler. This review did not prove the cancellation/maximum execution lifetime of an already dispatched Auth operation after a worker is terminated. No such surviving downstream operation was established as a production defect. If self-hosting, changing limits, or relying on retries/queued external work, revalidate that assumption or use an issuance coordinator whose exclusion survives for the operation's full lifetime. Documentation should not describe the generation fence as protection for external token replacement.

### Authorization, locks and earlier fixes

New `end_invite` is SECURITY DEFINER with empty `search_path`, explicitly revoked from public/anon/authenticated and granted to service_role. Existing `begin_invite` grants are preserved by replacement. Catalog checks confirmed ordinary callers cannot reserve/release addresses, cannot set pending admin roles, and cannot access the private generation table. Caller JWT/admin validation remains before service-role operations in the handler; credentials are not returned to the browser.

`begin_invite`/`end_invite` only lock the generation row. They do not introduce an additional Auth/profile lock dependency. Repeated the bounded two-session schedules from the preceding review with local lock waits, five-second statement timeouts and a 500-ms deadlock detector: save→confirmation, demotion→confirmation, deletion→save, save→deletion. All completed after releasing the first transaction, with the intended role/deletion result. Concurrent begin calls also completed without a deadlock.

The complete 127-test integration suite passed before and after restoring sensitivity mutations. In particular:

- **R4-01:** stale role saves and post-demotion saves remain fenced. The adapted tests explicitly expire the lease for the old/new-generation schedules; they test the generation fallback rather than bypassing the new exclusion silently.
- **R3-02:** confirmation-first and role-save-first schedules retain the accepted administrator intent without leaving an unconsumed promotion.
- **R3-03:** sequential latest-invite roles still set/clear pending promotion. In-flight duplication is now refused rather than allowed to race.
- **F-08:** unconfirmed accounts cannot be assigned staff/admin rights through the ordinary management RPCs; invite promotion remains confirmation-gated.
- **F-09:** the global admin advisory lock, self-demotion protection and last-admin check remain in place; the named concurrent-demotion regression passed.

A rolled-back populated fixture rebuilt 001–009 with registrations, admission history, staff assignment and legacy retries, then applied 010. Historical registration IDs, row counts and replay behavior survived. Adding nullable lease columns does not reserve existing addresses or discard pending promotions. Migration 010 also applied directly to the existing populated local stack.

## Camera and guest-message checks

The three original camera probes from review 5 all pass now: hiding during startup releases the eventual stream; Stop during enumeration stays stopped; Stop releases obtained media before detector initialization finishes. The checked-in tests additionally pass for both detector-failure orders, an older start yielding to a newer one, unmount during enumeration, and unmount before media resolves with the detector still pending. A further hide→show probe retained only the resumed stream and released it on cleanup. Hardware was mocked; physical-device permissions/driver behavior were not tested. The remaining switch continuation is R6-01.

Additional real-component registration probes passed for each server `invalid_input` field (`first_name`, `last_name`, `email`, `phone`), all five simultaneous client errors (two names, email, phone, unaccepted terms), and server `terms_changed` followed by a language switch. English alerts were replaced with Arabic alerts and injected `PRIVATE_DIAGNOSTIC` text was not shown. The checked-in general-error language-switch test also passed. No new raw `ApiError.message` rendering was found.

## Documentation and test-only corrections

- The created-by NULL boundary is now described accurately in `AUDIT_REMEDIATION.md`: non-null reassignment is refused; privileged NULL writes are indistinguishable from the FK action; ordinary callers lack the column grant, and future privileged writers need their own protection.
- Sensitivity notes now distinguish the old invariant guards from finding reproductions and correctly identify the historical generator targeted by R4-07. The new unmount-before-camera test uses a mounted video and asserts release while the detector is still pending, addressing the preceding review's false-positive test shape.
- The **per-path lock table** in 010 is accurate at the stated level. However, its extra sentence “no two paths take a pair in opposite orders” (010 lines 19–20 and the remediation-map prose) is literally inaccurate: the setter lists generation→profile while confirmation and demotion list profile→generation. The exercised same-target paths avoid a cycle through their preceding shared Auth-row/admin serialization, not through a universal absence of reversed pairs. Remove that sentence or document those serialization arguments. No deadlock was established from this wording alone.
- `76750e4` uses the database clock before the rate-limit bursts and waits for the next minute when fewer than ten seconds remain. It leaves application limits unchanged. This reduces the observed calendar-boundary flake; it is not a guarantee that an arbitrarily stalled burst finishes within a single minute. Its tests passed in this run.

## Test execution and sensitivity

Ran **`npm run test:all`** against the migrated local stack:

| Check | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Unit | 94/94 passed, 20 files |
| Integration | 127/127 passed, 13 files |
| Default Playwright | Nine browser-launch failures: configured `chromium_headless_shell-1243` executable absent |
| Complete browser suite using installed `/usr/bin/chromium` and ignored configuration | 9/9 passed, 53.4 seconds |
| Integration after restoring the lease counterfactual | 127/127 passed again |

The default command did not exit successfully as written because of the missing browser binary; the full browser suite passed using the explicit fallback. The existing local Auth health-check proxy issue remained, while functional Auth requests succeeded. No production validation or Wallet publishing was attempted.

**L** = literal historical implementation/test restored in an isolated copy or local function; **M** = focused behavior mutation preserving today's API. Missing RPCs/imports and launch errors were not counted as sensitivity. Database functions were restored after the counterfactual and validated by the full integration rerun.

| New/reworked check | Pre-fix sensitivity | Reproduction or invariant guard? |
| --- | --- | --- |
| R5-01 reservation/lease behavior | L: restore 009 `begin_invite` body, leaving 010 schema/current RPCs intact. Failed reservation assertion. | Finding reproduction |
| R5-01 real-handler pre-Auth overlap | Same L body. Failed because B was still waiting rather than refusing within the five-second bound; no subprocess timeout. | Finding reproduction |
| R5-01 reserve/release privileges | Passed with the same counterfactual; existing grants/010 cleanup API retained. | Invariant guard, not proof of the lease fix |
| Four new camera cancellation cases: pending detector Stop, hide during startup, enumeration Stop, early unmount | L: `ad6fcde` hook with current tests. All four failed the intended stop/status assertions. | Finding reproductions |
| Camera overlapping starts and unmount during enumeration | Passed with the same old hook, as documented. The two detector-rejection tests also still passed. | Invariant guards; enumeration test alone does not prove absence of an old post-unmount continuation |
| New combined field/terms language-switch test | L: `ad6fcde` registration/i18n implementations with current tests. Failed on the validation-language switch. The separate original server-terms probe passes on current code. | Finding reproduction; its first failed assertion prevents later assertions from independently running historically |
| Route checks for each provider | L: actual old flattened header test plus each narrowed config: 3/3 passed. Current route-aware tests with those same mutations fail. | Finding sensitivity demonstrated by paired configuration/checker versions |
| New checker self-test | M: make current `effective` ignore route matches, restoring flattened behavior. The self-test fails; other valid-config assertions pass. | Checker sensitivity |

The header mutation matrix also failed on conventional scoped overrides for scanner/assets/index.html on each provider, removal of the global Vercel CSP, and both original narrowed-source mutations. Case-varied overrides passed, producing R6-02. All such mutations were isolated copies; deployment files in this commit are unchanged.
