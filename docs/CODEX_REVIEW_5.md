# PassSystem verification review 5

Reviewed **28921c4**, changes **d15b07a..28921c4**, on 29 October 2026. The code change is `6e8fe01`; `28921c4` changes documentation. This review verifies the review-4 remediation and the requested earlier safeguards. It does not re-review unrelated changes. A subsequent remote commit, `76750e4`, was preserved but is outside this review.

**Result: two Medium and two Low findings.** The original invitation privilege races are closed in the tested schedules. Invitation delivery and camera cancellation still have gaps. No Critical or High issue was established.

Only this report is committed. Application source was not changed. Disposable probes, historical source copies, and logs were kept outside tracked files. All database/Auth/Edge tests used the local stack; production, hosted configuration, and production secrets were not accessed. The supplied production state was treated solely as context.

## Findings

### R5-01 — Medium — An older Auth request invalidates the newer invite's delivered link

**Location:** `supabase/functions/invite-staff/index.ts:103`, `supabase/functions/invite-staff/index.ts:164`; `supabase/migrations/20261029000009_review4_remediation.sql:39`.

Generation checks fence the role save, but do not fence Auth's token issuance. An obsolete request can still replace the token belonging to the current successful invite.

**Concrete reproduction:** Run the actual checked-out Edge handler against local Auth/PostgREST, delaying just A's outgoing `admin/generate_link` request:

1. Administrator invite A reserves generation 1, then pauses before Auth issues its link.
2. Staff invite B reserves generation 2, issues its link, saves the staff role, and returns `200 {ok:true, link: ...}`.
3. Resume A. Its Auth call issues another token for the same account, replacing B's token. Its role save correctly returns `stale`; the handler correctly returns `409 invite_superseded` with no link.
4. Redeem **B's** returned link. Local Auth returns `otp_expired`.

Observed: `latestOk:true`, `staleStatus:409`, `staleError:invite_superseded`, `staleHasLink:false`, `latestAcceptance:otp_expired`. No privilege escalation was observed. The current invite becomes unusable even though its administrator received a successful result; email issuance has the same unfenced external operation, although this reproduction used link delivery.

**Suggested fix:** Serialize the complete issuance operation per normalized email, including Auth token creation and role persistence, using a durable coordinator/queue or equivalent ownership protocol. A generation read immediately before the HTTP call is insufficient: another request can reserve a generation between that read and issuance. Ensure an obsolete issuer cannot replace a newer returned token. Add a real-handler regression that pauses **before token issuance**, rather than only before the role RPC.

### R5-02 — Medium — Camera cancellation still depends on unfinished startup work

**Location:** `src/scanner/useCameraScanner.ts:100`, `src/scanner/useCameraScanner.ts:109`, `src/scanner/useCameraScanner.ts:130`, `src/scanner/useCameraScanner.ts:202`.

The two detector-rejection orders from review 4 are fixed. Three other deterministic schedules still fail with mocked MediaStreams and the real hook:

1. **Hide during startup:** call `start()`, hide the document before media resolves, then resolve media and enumeration. The visibility handler checks only `runningRef`, which is false during startup. The hook reaches `running` while hidden; the acquired track has not been stopped.
2. **Stop during enumeration:** resolve the detector, camera, and video playback, but defer `enumerateDevices()`. Call `stop()`, then resolve enumeration. The old start unconditionally sets `runningRef=true` and status `running`, undoing the stopped state and restarting its loop. There is no generation check after enumeration. The same continuation can run after unmount or a newer start; the Stop reproduction observed `running` instead of `idle`.
3. **Stop while detector initialization remains pending:** resolve media first while keeping detector initialization pending. Call `stop()`. The stream already exists, but is neither in `streamRef` nor registered for cancellation; its track is not stopped until the detector promise eventually settles. A hung initializer leaves the obtained camera stream alive. The local probe settled the detector afterwards for cleanup and asserted the stop count captured before settlement: zero.

All three additional local tests failed for these reasons. These are hook lifecycle reproductions; no physical camera test was performed.

**Suggested fix:** Track each acquired stream as soon as its media promise resolves, independently of detector readiness, and register it with cancellation immediately. Cancel pending starts on hide as well as running starts. Recheck generation, mounted/visible state, and stream ownership after every asynchronous boundary, including enumeration and video playback, before mutating state or starting a loop. Add the schedules above, plus overlapping starts and unmount during enumeration, to the hook tests.

### R5-03 — Low — Terms and field errors retain the language used when the error occurred

**Location:** `src/pages/public/RegisterPage.tsx:125`, `src/pages/public/RegisterPage.tsx:134`; also validation at `src/pages/public/RegisterPage.tsx:86`.

General submission errors and page-load errors now store codes and translate during rendering. Terms and field errors still store already translated strings in `errors`.

**Concrete reproduction:** Render the real registration page inside `LangProvider`, with attendance terms enabled. In English, fill valid names, accept the terms, and mock the submit RPC to reject with `ApiError('PRIVATE_DIAGNOSTIC', 'terms_changed')`. After the event reload, switch to Arabic. The page changes language, but the terms alert remains:

> The organizer has just updated the attendance terms. Please read them again and accept.

The additional local test failed because that English alert remained after switching. Ordinary validation and server `invalid_input` field alerts use the same string-storage pattern. Raw server diagnostic text was not rendered in this scenario.

**Suggested fix:** Store structured validation/error codes and interpolation arguments for all field and terms errors, then translate them during render. Test language switching after `terms_changed`, `terms_not_accepted`, and a field error, alongside the existing general submission-error test.

### R5-04 — Low — Header regression tests ignore which URLs receive the headers

**Location:** `src/lib/securityHeaders.test.ts:20`, `src/lib/securityHeaders.test.ts:25`, `src/lib/securityHeaders.test.ts:45`.

The tests compare header values after discarding their deployment rules. Vercel blocks are flattened, and the Netlify regex does not retain their `for` paths. Removing effective CSP coverage from the application can therefore pass all three tests.

**Concrete reproduction:** In an isolated copy of the current files, perform either mutation separately:

- Change the Vercel security-header rule's `source` from its application-wide matcher to `/never-used/:path*`.
- Change Netlify's security-header rule from `for = "/*"` to `for = "/never-used/*"`.

Leave every header value unchanged. In each case, `vitest run --project unit src/lib/securityHeaders.test.ts` reports **3 passed**, although the repository's security-header configuration no longer applies those headers to the ordinary app routes. This was a configuration/test mutation, not a deployment; the checked-in deployment files currently cover the app correctly.

**Suggested fix:** Parse deployment rules with their paths intact and assert effective required headers for `/`, guest registration/pass routes, staff/scanner routes, and assets as appropriate. Test absent coverage and scoped overrides as well as changed values. Continue comparing the policy values to the generator.

## R4 findings – fixed? yes/no/partly

| Finding | Fixed? | Verification / remaining limitation |
| --- | --- | --- |
| R4-01 | partly | Both original role interleavings now reject stale saves; explicit demotion invalidates in-flight promotions. Separate administrator issuers, acceptance before persistence, removal/re-invite, and generation-0 cases were exercised. Stale results return 409 without a link. Token issuance itself remains unfenced: R5-01. |
| R4-02 | partly | Both detector-rejection orders release their streams, and the checked-in unmount test passes. Pending initialization, hiding during startup, and enumeration continuations still violate cancellation: R5-02. |
| R4-03 | yes | Deleting a demoted creator clears `events.created_by`, preserves event/admission history, and clears the other tested Auth-reference fields. Reassignment to another non-null creator is still blocked, including direct owner SQL. See the precise NULL-write boundary below. |
| R4-04 | partly | Unknown diagnostics are replaced with approved messages. Registration/pass load errors and general submission errors translate on switching language. Terms/field alerts do not: R5-03. |
| R4-05 | yes | CRLF, lone CR, LF and forbidden ASCII controls handled correctly; tab retained; mixed Arabic/Latin/emoji content preserved; physical lines at most 75 octets. |
| R4-06 | yes | Decomposed 003-era names replay canonically; full-capacity retry succeeds without another row. Different name, email, phone or request UUID does not obtain the old pass. |
| R4-07 | partly | Historical wildcard generator and direct policy-value widening are detected. Header rule coverage is not: R5-04. |

## What was checked and found sound

### Invitation authorization, generations and earlier safeguards

- The Edge handler still validates the caller JWT through Auth and checks the caller's administrator profile before using its service-role client. Privileged credentials remain server-side. New generation RPCs are service-role-only; local catalog checks showed no `anon`/`authenticated` execution grants and empty `search_path` on both SECURITY DEFINER functions. Ordinary roles have no permissions on `private.invite_generations`.
- The two original real-handler schedules were rerun: an old admin role save after a newer staff invite, and an old save after newer acceptance plus explicit demotion. The old request cannot re-grant rights. The first schedule also used two distinct administrator issuers.
- Accepting a current admin invite before its role save produces `granted` and an admin profile. Accepting a newer staff invite before saving its role does not consume an older admin intent as current. Demotion during a target's in-flight request makes that save stale.
- Removing a pending account and re-inviting the same email creates a different Auth user ID. The old ID's role save returns `not_found`; it does not affect the new account. The new staff link accepts without administrator rights. A missing target uses the handler's existing warning fallback, not its `stale` branch.
- Imported generation-0 promotions are accepted when no generation row exists, consumed once, and rejected as promotions after a newer generation is reserved. There is no unconditional promotion from the legacy app-metadata flag.
- **R2-01, R3-02, R3-03, F-08 and F-09** retain their tested safeguards under 009: transition-only promotion/consumption, acceptance-versus-save ordering, sequential latest-role decisions, confirmation-gated staff/admin assignment, and serialized demotion with self/last-admin protection. Their named regression groups passed in the complete 124-test integration suite before and after counterfactual restoration. R3-03's original sequential role behavior remains fixed; R5-01 concerns delivery under overlapping Auth issuance.

### Locks and deletion boundaries

The documentation's phrase “one lock order everywhere” is not a literal description of every path. `set_pending_admin` takes admin → Auth → generation → profile. `set_user_admin` takes the admin lock, updates the profile, deletes pending intent, then advances the generation; it does not lock the Auth row. Confirmation runs under the Auth row lock, upserts the profile, consumes pending intent, then reads the generation `FOR SHARE`. `begin_invite` only changes the generation row. These differences deserve accurate documentation, but a deadlock was not established in the exercised paths.

Additional two-session schedules used observed PostgreSQL lock waits, 5-second statement timeouts, and a 500-ms deadlock detector: save then confirmation, demotion then confirmation, deletion then save, and save then deletion. Releasing the first transaction allowed the second to finish in all four cases. Existing acceptance-first and promotion/deletion guard regression tests also passed. There is no claim of exhaustive proof against all possible privileged multi-statement transactions.

The Auth-reference `ON DELETE SET NULL` columns are `events.created_by`, `event_staff.created_by`, `registrations.checked_in_by`, `registrations.revoked_by`, and `admission_logs.operator_id`. The creator-deletion test exercises assignment/admission cleanup and retains history. The profile deletion guard remains enabled; pending promotions cascade with the deleted Auth user, while email generations intentionally survive removal.

**Creator immutability boundary:** 009 prevents substitution with another non-null creator, but deliberately allows NULL. A direct owner SQL `UPDATE events SET created_by=NULL` succeeds even while that Auth user exists; the trigger does not authenticate that the update came from an FK action. Ordinary authenticated users cannot update this column, and no exposed SECURITY DEFINER RPC in the reviewed application writes it, so no application-user bypass was established. A future privileged function accepting arbitrary creator writes would need its own protection. If the requested invariant includes arbitrary owner/SECURITY DEFINER NULL writes, it is not enforced by this trigger; its “only that foreign-key action” comment describes current callers, not a trigger-level guarantee.

### Guest messages, calendar, replay and migration compatibility

- No guest load/submit/terms/pass-refresh branch found renders `ApiError.message`. Additional real-component tests passed for unknown registration-load and pass-load diagnostics, language switching without refetch, and an unknown pass-refresh failure retaining a ready pass without displaying diagnostics. The checked-in general submission test passed. Known error codes still use approved translations. The remaining terms-language problem is R5-03.
- Calendar tests plus an additional long mixed Arabic/Latin/emoji/control-character input preserved Unicode and produced no forbidden ASCII text controls. Maximum physical line length was exactly 75 octets. The synthetic URL token appeared once, in its URL; production call sites still supply generated pass URLs and hashed UIDs. The `URL` property is not a general arbitrary-input sanitizer; its current caller constructs that URL.
- A 003-style NFD registration in a one-seat full event replayed with NFC input and retained one row. Changing the name, email, UUID or phone returned `event_full`, no token, and still one row. Existing legacy-key and terms/replay-order regressions also passed.
- Migration 009 applied directly to the existing populated local 008 database. Separately, a rolled-back fixture rebuilt 001–008 with registrations, admitted history, staff assignment, and legacy retries, then applied 009. Original registration IDs and retry behavior survived, with unchanged row count; historical phone/consent NULL values remained intact. New ordinary-role grants were absent. This did not reset or inspect production.

## Test execution and sensitivity

### Baseline

Ran the requested **`npm run test:all`** against the local Supabase stack after applying 009 and restarting only the local Edge runtime:

| Check | Result |
| --- | --- |
| Typecheck | Passed |
| Lint | Passed |
| Unit | 86/86 passed, 20 files |
| Integration | 124/124 passed, 12 files |
| Default Playwright invocation | Nine launch failures: configured `chromium_headless_shell-1243` executable absent |
| Complete browser suite with installed `/usr/bin/chromium` through an ignored configuration | 9/9 passed, 48.6 seconds |
| Integration after restoring all database counterfactuals | 124/124 passed again |

The default `test:all` command therefore did **not** exit successfully as written; the equivalent browser suite passed using the explicit browser fallback. The local Auth container retains its previously diagnosed proxy-related health-check status; Auth requests and the local functional suites succeeded. No production test or Google Wallet publishing operation was attempted.

### L/M sensitivity method

**L** means literal historical implementation restored in an isolated source copy or saved local function body. **M** means a focused mutation restoring the faulty behavior while preserving current RPC/import contracts. Missing RPCs, missing exports, and browser-launch failures were not counted as regression sensitivity. Database definitions were restored after every case and again at the end.

| Target | Counterfactual | Outcome |
| --- | --- | --- |
| R4-01, all five new integration cases | M: disable generation rejection in the current four-argument setter; restore literal 007 Auth-transition and demotion bodies | All 5 failed meaningful stale/role/HTTP assertions; no child-process timeout. This retains the current admin-lock rendezvous used by the Edge test rather than producing an incompatible old RPC failure. |
| R4-02, detector fails first / detector fails last | L: `d15b07a` hook with current tests | Both failed track-stop assertions. |
| R4-02, unmount mid-start | Same L snapshot | **Passed before the fix too.** The test has no mounted video; the old start eventually encounters the missing video and its catch cleans up. It does not prove early cancellation or the generation change. |
| R4-03, creator deletion/history test | L: original `validate_event` body | Failed because the creator reference remained. |
| R4-03, non-null creator reassignment test | Same L body | **Passed before the fix too**, as expected for an invariant already protected before 009. |
| R4-04, modified i18n test and new registration diagnostic/switch test | L: `d15b07a` i18n, registration and pass implementations with current tests | Both failed; approved generic-message assertions were not satisfied. |
| R4-05, new newline/control test | L: `d15b07a` calendar implementation | Failed on unescaped/forbidden controls. |
| R4-06, NFD replay integration test | L: literal 008 registration function | Failed replay assertion. |
| R4-07, three new header tests | L: actual `9918dc4` generator, with only the current pinned-origin export supplied for import compatibility | All 3 failed on policy/asserted-header behavior. Current generator already existed at `d15b07a`; these tests appropriately pass against that generator. |

For direct deployment-value mutations, substituting a wildcard Supabase origin, scheme-wide `https:`, or a different exact project in **either** deployment file independently failed the deployment equality test: six sensitive mutations. The two path-coverage mutations passed, producing R5-04.

Thus the blanket statement at `docs/AUDIT_REMEDIATION.md:113` that each test failed against previous code is too broad. The two explicitly identified negative/invariant tests passed historically, and R4-07 targets the earlier faulty generator rather than a nonexistent generator change in 009. This does not negate the positive sensitivity demonstrated above. Strengthen the unmount test with a mounted video, a deliberately pending detector/enumerator, and a stop assertion before resolving it; describe invariant-preservation tests separately from tests that reproduce a former failure.

Additional uncommitted probes intentionally failing on **current** code: the three camera schedules in R5-02 and the terms-language switch in R5-03. The invitation issuance race and header-coverage mutations produced the results recorded above. Reproductions used mocks only for scheduling/browser hardware or API failure injection, with the real hook/components/handler and local Auth/database behavior where stated.
