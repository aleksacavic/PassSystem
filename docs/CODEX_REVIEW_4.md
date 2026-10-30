# PassSystem — verification review 4

Date: 2026-10-29 (Asia/Dubai). Reviewed head: **`e8c0de1`**.

Part A covers `b272576..e8c0de1`. Part B re-examines the complete application
and migrations 001–008 against all 28 prior finding IDs. No production endpoint,
Supabase project, Vercel deployment, or environment secret binding was accessed
or changed. Existing disposable local-stack credentials were used for tests.
No application code, checked-in tests, manifest, or lockfile was changed.

**Result:** 3 Medium findings and 4 Low findings. Existing suites pass with the
browser qualification below; the independent failing probes demonstrate gaps
that those suites do not cover. This is not a finding-free verification.

## Findings

### R4-01 — Medium: stale invitation operations can override newer roles and revocations

**Status:** verified, using the unmodified invite-staff handler and real local
Auth/Postgres operations.

**Location:** `supabase/functions/invite-staff/index.ts:143` and
`supabase/migrations/20261028000008_review3_remediation.sql:39`, especially the
immediate grant at line 50 and pending-intent update at line 58.

008 correctly orders one role operation against Auth confirmation. It does not
bind that operation to the invitation generation that caused it. Auth token
issuance and `set_pending_admin` are separate HTTP operations, so their order
can differ between concurrent requests. The Auth row lock serializes arrival
at the setter, not invitation freshness. Consequently “latest invite decides
the role” remains false under concurrency.

**Reproduction A:** start administrator invitation A and pause its request to
`set_pending_admin` after Auth generated its link. Issue a later staff invitation
B for the same address and let B finish, returning `admin: false`. Release A's
older role operation, then accept B's still-valid link. Local result:

```text
latestReportedAdmin: false
accepted: true
actualAdmin: true
```

**Reproduction B:** while A is paused, issue and accept a newer administrator
invitation B. Explicitly demote that user through `set_user_admin(..., false)`.
Release A. Because the user is now confirmed, A takes the immediate-grant branch
and changes `is_admin` **false → true** again. This was also reproduced.

The probe gated only the older local HTTP step; it did not substitute the role
decision or Auth responses. Both issuers were authorized administrators. This
is a stale privileged action overriding newer intent, not anonymous access.
It partly reopens R2-01's revocation guarantee and R3-03's role-ordering guarantee.

**Suggested fix:** fence role mutations with a trusted per-invitation generation
and invalidate earlier generations on explicit demotion/cancellation. Link
issuance, pending intent, and post-confirmation grants must refer to the same
current generation; holding a row lock only inside the final RPC is insufficient.
Return the effective, generation-validated role. Add both interleavings above,
including two independent issuers, to the Edge integration tests.

### R4-02 — Medium: detector startup failure can leak a late camera stream

**Status:** verified by a failing hook test against current application code;
this is an incomplete F-14 remediation, not introduced by the redesign.

**Location:** `src/scanner/useCameraScanner.ts:94` through line 103.

The stream is assigned only after `Promise.all([getQrDetector(), getUserMedia()])`
succeeds. If detector startup fails first, the catch block runs with
`stream === null`. Camera acquisition can subsequently succeed, but that late
stream is never assigned to a tracked variable and its tracks are not stopped.
The generation check is never reached. Stop/unmount cannot explicitly release
that untracked stream; cleanup is left to the browser's eventual reclamation.

**Reproduction:** mock detector initialization to reject (for example, failed
WASM loading), keep getUserMedia pending, and call the real hook's `start()`.
After start has handled the detector error, resolve getUserMedia with a stream
whose track has a stop spy. Unmount the hook. The expected stop count is one;
the actual count was **zero**. No camera hardware is needed to test this resource
ownership path. No such checked-in regression currently exists.

**Suggested fix:** track/release each successful acquisition independently of
the combined promise's success, including failures, cancellation, and unmount.
Preserve generation checks for competing starts. Add deferred-promise tests for
both failure orderings; hardware testing is still needed for actual devices.

### R4-03 — Medium: deleting an event creator leaves a dangling Auth foreign-key value

**Status:** verified through the real local Auth deletion API. Found during the
whole-system Auth-cascade review; this predates the new commits.

**Location:** `supabase/migrations/20261028000001_core_schema.sql:217`, interacting
with `events.created_by ... ON DELETE SET NULL` at line 58.

The event validation trigger restores `NEW.created_by := OLD.created_by` on
every UPDATE, including the update generated by the foreign-key deletion action.
It undoes the intended SET NULL. The Auth deletion succeeds, but the surviving
event still contains the deleted user's UUID, leaving a dangling reference.
Ordinary removal/access-revocation tests cover operators, not event creators.

**Reproduction:** create an event as administrator C, then have another
administrator demote C. Delete C with the Auth admin API. The local result was:

```text
Auth deletion succeeded: true
Auth user still exists: false
event.created_by still equals C: true
```

The orphan was independently detected with
`created_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = created_by)`.
Access removal itself succeeds; creator-reference cleanup does not.

**Suggested fix:** allow legitimate foreign-key cleanup while preserving the
unprivileged immutability requirement. Authenticated column grants already
exclude writes to created_by; do not unconditionally restore it during trusted
SET NULL actions. If historical actor identifiers must be retained, store them
in an explicitly historical field rather than violating the live reference.
Test creator deletion after demotion and assert both preserved event/history
records and absence of orphaned references.

### R4-04 — Low: unknown API errors are rendered verbatim to guest pages

**Status:** verified in the Arabic registration UI and in a focused helper test.

**Location:** `src/lib/i18n.ts:230`–238; its use in
`src/pages/public/RegisterPage.tsx:138` and the pass error path.

Known codes map to approved translations, but unknown codes return the supplied
server message unchanged. That contradicts the requested “no raw server text”
boundary and can expose diagnostics or untranslated English to guests. The new
i18n unit test actually expects raw fallback text, so the suite protects the
undesired behavior. React escapes this text; no HTML execution was demonstrated.

**Reproduction:** on an Arabic registration page, return a local mocked
PostgREST error with code `XX000` and message `INTERNAL_REVIEW4_SENTINEL`.
The literal sentinel becomes visible. The helper likewise returns it unchanged.

**Suggested fix:** use an approved localized generic fallback for unknown codes
and keep raw diagnostics out of guest-rendered state. Store codes rather than
already-translated error strings where language switching must update errors.
Replace the unit assertion that currently expects the raw server fallback.

### R4-05 — Low: calendar TEXT escaping leaves lone carriage returns unescaped

**Status:** verified by a focused test and an actual downloaded calendar file.

**Location:** `src/lib/calendar.ts:17`.

The newline replacement handles LF and CRLF but not a lone CR. Event name and
location validation permits that character through the API. The resulting TEXT
property contains an unescaped control character and is not valid RFC 5545 text;
calendar import behavior can vary. The UTF-8 folding and normal newline escaping
work. No calendar-client exploit was demonstrated.

**Reproduction:** create an event whose name contains `أمسية\rمراجعة`, register,
and download its calendar file. After removing legitimate CRLF delimiters,
the file still contains a raw `\r` in SUMMARY. The focused `Gala\rSecond line`
case fails the same check. The existing calendar tests do not cover it.

**Suggested fix:** normalize CRLF, lone CR, and LF before TEXT escaping and
reject/remove other prohibited control characters. Retain octet-aware folding
and test all newline forms with mixed Arabic/Latin text and punctuation.

### R4-06 — Low: legacy 003 retries miss canonically equivalent decomposed names

**Status:** verified in a rolled-back local fixture. R2-05 remains incomplete
for this populated-data edge case.

**Location:** `supabase/migrations/20261028000008_review3_remediation.sql:197`
(also present in the corresponding 007 comparison).

The old 003 cleaner did not apply NFC; the current cleaner does. Legacy lookup
compares lowercased stored names with the new normalized names without
normalizing the stored side. An identical request made before the normalization
change can therefore miss its existing row, despite the correct legacy UUID
hash and unchanged logical attendee details.

**Reproduction:** within the replay window, seed a valid 003-format registration
for `Cafe\u0301`, last name `Legacy`, and request UUID X. The historical cleaner
produces that decomposed value. Submit the same raw name and X to the current
RPC, with terms disabled or a valid current acceptance. The current cleaner
produces `Café`; replay fails to match. Local result:

```text
ok: true
replayed: false
registrations: 2
```

At capacity this can instead prevent recovery of the already-issued pass.
ASCII 003/004 retries work, and no cross-attendee credential disclosure was found.

**Suggested fix:** compare canonically normalized stored legacy names with the
normalized request, retaining the UUID, event, email, and empty-phone checks.
Add populated-data tests with decomposed accents, not only ASCII legacy names.

### R4-07 — Low: the named CSP regression does not detect the original widening

**Status:** verified test-coverage gap; the current source policy is correctly
pinned. This is not a claim that the current CSP is vulnerable.

**Location:** `tests/e2e/workflow.spec.ts:224`, with console collection at line 32.

The workflow asserts that legitimate operations generated no CSP violations.
That property also holds for a more permissive policy. The configured local
origin additionally means this test does not exercise the historical production
default wildcard.

**Reproduction:** run the unchanged main workflow with the actual
`9918dc4:security-headers.mjs` generator and the same local API override required
by the fixture. It still passes, including the zero-violations assertion. This
was executed: **1 passed**. Thus the documented F-15 test does not fail merely
because the pre-fix generator is restored.

**Suggested fix:** assert the production/default connect-src allowlist and its
Vercel/Netlify equivalents explicitly, including absence of the wildcard and
unused WebSocket permission. A browser test can also attempt a safely intercepted
disallowed-origin connection and require CSP to stop it. Keep the existing
positive no-violations check for application compatibility.

## Prior findings – still fixed? yes/no/partly

“Yes” concerns the stated fix at this head, not a production readiness claim.
The sensitivity column distinguishes actual historical source from equivalent
pre-fix behavior; passing current tests alone was not treated as proof.

- **L:** current named tests executed against literal historical source in a
  temporary snapshot outside the checkout.
- **M:** current named integration tests executed against an isolated pre-fix
  behavior mutation in the local database, retaining the current RPC interface.
  This avoids counting “function missing / wrong signature” as defect detection.
  Original SQL bodies were used where compatible. Definitions were restored
  after each case, and all 116 integration tests passed again afterward.
- **No sensitive test:** no discriminating named test was established; details
  are given rather than implying mutation coverage.

| ID | Still fixed? | Current verification and named-test sensitivity |
| --- | --- | --- |
| F-01 | Yes | Honest timeout retry replays one admission; a new scan rejects reuse. M: disabling attempt caching fails the F-01 integration cases. L: pre-004 scanner fails both retry/attempt-ID UI cases. |
| F-02 | Yes | Local default does not trust forged CF headers. M: restoring trust=1 fails the named default/diagnostic assertions. Hosted header trust still needs infrastructure verification; see residual risks. |
| F-03 | Partly | IPv6 /64 grouping works. M: literal 003 fingerprinting fails the equality assertion. CAPTCHA, rotating-address abuse, event-wide exhaustion, and bulk cleanup remain open. |
| F-04 | Yes | New request hashes bind normalized details and phone; legacy fallback is constrained. M: UUID-only new keys fail the changed-attendee test. R4-06 is a separate legacy normalization miss. |
| F-05 | Yes | Restoration takes the capacity lock and checks occupancy. M: the literal 003 restore function fails the capacity regression. |
| F-06 | Yes | 008 FOR SHARE is compatible with admission's event KEY SHARE; capacity/replay ordering is preserved. M: restoring the conflicting event FOR UPDATE makes the held-admission test fail. This is not a proof of every possible multi-transaction interleaving. |
| F-07 | Yes | Wrong-event logging redacts identifiers without access to the other event. M: removing that authorization branch fails the negative case; the authorized positive case still passes. |
| F-08 | Yes | Assignment/promotion require confirmation; pending intent is service-only. M: removing the assignment check and restoring early promotion fails both corresponding assertions. R4-01 concerns stale authorized intent, not promotion of an unconfirmed account. |
| F-09 | Yes | Admin demotions serialize; the last-admin/self-demotion checks remain. M: removing the admin lock fails the two-session mutual-demotion case. The profile deletion guard also remains active. |
| F-10 | Yes | NFC and tested invisible/bidi rejection remain in client/server validation. M: literal 003 cleaning fails rejection and NFC assertions. L: the old client fails the invisible-format test. No claim of exhaustive Unicode equivalence is made. |
| F-11 | Yes | Same-origin URL normalization and route error handling remain. L: the old navigation helper fails the tab/protocol-relative redirect case. |
| F-12 | Partly | Expiry filtering and explicit forget work. L: old storage code fails expiry filtering; the pre-existing forget helper already passed its unit test. Current Arabic UI removal cleared storage without revoking the pass. Valid saved passes remain exposed to the next user of a shared browser until removal/expiry. |
| F-13 | Yes | Scanner remounts per event. L: the unkeyed historical scanner fails the stale-header regression. The redesign retains the key. |
| F-14 | Partly | Generation checks and chosen-device retention remain, but the late-stream failure path still leaks explicit cleanup (R4-02). No checked-in named lifecycle regression exists; the new independent hook test fails now. |
| F-15 | Yes | Default/static policies remain pinned and omit the old wildcard/WebSocket allowance. The named browser workflow also passes with the old generator, so it is not sensitive to the original defect (R4-07). |
| F-16 | No | Deferred: PKCE/secure-password-change/general remote-session hardening are not implemented as a completed fix. Account deletion now revokes staff access, but is not general remote sign-out or non-destructive disable. |
| F-17 | Yes | DST-gap rejection remains. L: the old event validator fails the named non-existent-time assertion. |
| R2-01 | Partly | Old app-metadata regrant is closed and demotion clears pending intent. M: restoring flag-based promotion fails the demoted-invitee regression. 008's stale immediate-grant path can nevertheless override a newer demotion (R4-01). |
| R2-02 | Yes | Attempt event/credential binding and serialization remain. M: dropping credential comparison fails both mismatch/concurrent-conflict cases. Legitimate same-credential retries continue to work. |
| R2-03 | Yes | New registrations require the shown terms version; version history is recorded; a completed request replays before a new terms acceptance is required. M: removing version comparison fails the stale-terms regression. |
| R2-04 | Yes | Profile guard protects administrators in the deletion transaction. M: disabling it makes the direct Auth-delete regression fail. Ordinary creator-reference cleanup has the separate R4-03 defect. |
| R2-05 | Partly | ASCII 003/004 retries match without adding rows. M: disabling legacy alternatives fails both named cases. Decomposed pre-NFC names still duplicate (R4-06). |
| R2-06 | Yes | Current row sharing orders registrations with archival/edits. M: removing FOR SHARE fails the archival-wait regression. The other test manually takes the shared lock, so it is not independent proof that the RPC takes it. |
| R3-01 | Yes | 007's event-update advisory trigger is absent; slug-edit and in-flight-edit regressions pass. M: restoring that trigger makes the slug/capacity case fail; a short local lock timeout bounded the counterfactual. |
| R3-02 | Yes | Auth user FOR UPDATE waits for confirmation and then grants/clears appropriately. M: an ABI-compatible recreation of the unlocked 007 marker fails both named ordering/outcome cases. Stale generations are a separate gap in R4-01. |
| R3-03 | Partly | Sequential role replacement and pending-admin badge work. M: retaining pending intent on false makes the named downgrade case fail. Concurrent generations and later demotion remain vulnerable to stale requests (R4-01). |
| R3-04 | Yes | Roving Tab stop, arrows, wrap, Home/End, focus and click selection pass. L: the pre-008 component fails the named keyboard test. |
| R3-05 | Yes | Scanner camera/frame/mask/foreground use tokens; night styling inherits scoped semantics. L: pre-008 components fail the current raw-colour check. The deliberate Google Wallet artwork exception remains. |

## Verification results and method

| Check | Result |
| --- | --- |
| `npm ci` with writable cache | Passed; checked-in lockfile unchanged. |
| Migration 008 on the existing populated local 007 database | Applied successfully. |
| `npm run test:all` | Typecheck/lint, **78 unit/component tests** and **116 integration tests** passed. Its browser stage failed to launch all 9 tests because the pinned Playwright executable is absent. Those are environment launch failures, not executed browser assertions. |
| Browser suite with installed Chromium override | **9 passed**, same checked-in workflows/assertions and local production preview/CSP. The exact pinned browser was not verified. |
| Production build / bundle-secret scan | Passed; no privileged secrets detected in 19 scanned built files. Font assets were emitted as files, including a 1.71 KB font that would otherwise be an inlining candidate. |
| Database sensitivity matrix | **19/19** selected pre-fix behavior cases were detected by their named regression tests; no child-process timeout. Each mutation was restored before the next. |
| Literal pre-fix unit snapshots | `9918dc4`: 7 expected failures covering F-01/F-10/F-11/F-12/F-13/F-17. `d6a8752`: 2 expected failures covering R3-04/R3-05. Filtered-out tests are not counted as executed. |
| Restored database revalidation | **116/116 integration tests passed again** after the counterfactual matrix. |
| Populated 001–008 fixture | Real migrations applied inside a rolled-back transaction. Registration IDs/counts, admitted history/logs, staff assignment, and profile confirmation survived. Legacy pending intent was imported/consumed; stale flags were ignored; ASCII legacy replay still matched after 008. Historical null phone/consent fields stayed null. |
| Focused current-code failures | Camera cleanup expectation failed (0 stops); unknown guest error fallback and lone-CR calendar checks failed; legacy NFD retry produced 2 rows; stale invitation role/revocation and creator orphan were independently reproduced. |

Sensitivity testing did **not** edit application files or checked-in tests.
Historical source snapshots and added probes were temporary/ignored helpers.
The database matrix used literal older SQL where interfaces matched, otherwise
small counterfactual changes restoring the relevant pre-fix behavior while
preserving the current calling convention. It is not a claim that every modern
test was run unchanged against an entire historical deployment. That distinction
matters because a missing RPC alone would be a misleading failure.

The M matrix covered F-01 through F-10, all R2 IDs, and R3-01 through R3-03.
The L runs additionally covered the client/storage/navigation/DST and UI-token
changes above. Together they establish sensitivity for at least the implemented
portion of 25 prior IDs; F-14 has no named lifecycle test, F-15's named test is
not discriminating, and F-16 is deferred. Sensitivity does not establish complete
coverage: R4-01/R4-02/R4-06 still escaped the existing tests.

## Additional checks found sound

- **Arabic/RTL:** an actual Arabic registration accepted Arabic names. Guest
  html lang/dir became `ar`/`rtl`; switching language did not refetch the event.
  Following the guest-to-staff SPA link reset them to `en`/`ltr`, while the saved
  guest selection remained `ar`. Staff/scanner direction did not inherit RTL.
  Known API codes use localized messages; unknown codes have R4-04's exception.
- **Honeypot:** filling the repositioned website field produced the translated
  invalid-input response and **zero registrations**. Clearing it allowed normal
  registration. It remains outside pointer/keyboard/assistive interaction and
  is still submitted to the server. This is not a substitute for CAPTCHA.
- **Calendar credential handling:** the actual download used a 24-hex-character
  hashed UID. The raw pass credential occurred only as part of the expected
  pass URL, in URL/notes; removing that URL left no token elsewhere. Physical
  lines stayed within 75 UTF-8 octets and Arabic characters survived folding.
  Lone-CR escaping is the separately reproduced defect.
- **Fonts/CSP:** four same-origin font resources loaded in the Arabic browser
  check, the Arabic font was available, and there were zero font-CSP violations.
  `assetsInlineLimit` excludes font extensions; `font-src 'self'` remains intact.
  No external font service was contacted by the tested flow.
- **Polling/load:** scanner summary requests were **1 initially / 2 after 16 s**;
  the night wrapper computed `color-scheme: dark`. The overview made **3 log
  requests over 16 s**, including initial loads. Its parent summary poll is
  10 s; the feed has a 15 s timer plus refresh on changed counts, so “15 s” is
  not an exclusive upper frequency. Existing visibility gating/cleanup remains.
  Names add a query when IDs exist. This is bounded polling, not a load test;
  there is no in-flight deduplication for unusually slow responses.
- **Access control:** all five public application tables have RLS enabled.
  Private tables are unexposed and grant neither ordinary role table access;
  they are not being represented as RLS-enabled tables. Catalog checks found
  no application SECURITY DEFINER without an empty pinned search_path. Anon's
  public executable functions remained exactly get_public_event, get_pass, and
  register_for_event. New pending-role mutation remains service-role-only;
  pending-role listing remains administrator-checked.
- **Edge Functions:** invite/remove still validate the caller with Auth and
  check the administrator profile server-side. Caller-supplied IDs/metadata
  are not accepted as authority. Role/list/guard tests pass. Wallet lookup and
  signing remain server-side, normalize/hash the bearer pass, reject unknown
  and revoked credentials, and verify signatures with the disposable test key.
  No privileged key was introduced into client imports/configuration. Broad
  CORS does not replace or bypass bearer authorization on administrator routes.
- **Locking:** attempt advisory locks precede registration-row locks; capacity
  changes and restoration retain their per-event serialization. 008 removes
  the event-update capacity trigger and uses event FOR SHARE before replay or
  insert; ordinary admission's parent KEY SHARE is compatible. Admin demotions
  retain their global lock; role setting locks the Auth row before confirmation-
  dependent work. This review exercised the named interleavings and countercases,
  not a proof that every arbitrary multi-call SQL transaction is deadlock-free.
- **UI/admission:** current success/red/amber, event isolation, timeout retry,
  CSV/reporting, camera simulation, invite acceptance/reuse, and wallet redirect
  workflows pass. No redesign change to API privileges/RLS was found. Forgetting
  a pass in the Arabic UI removed its local storage entry without revoking the
  still-valid server pass.

## Residual risks and rollout context

- **F-03 is accurately described as partial:** /64 grouping does not stop
  rotating networks, event-wide bucket exhaustion, or junk filling capacity.
  CAPTCHA and bulk cleanup are not implemented. The simple honeypot does not
  change that assessment. The public wallet endpoint also still lacks an
  application-level request/signing limiter, as already documented.
- **F-16 remains deferred:** the local config still disables secure-password-
  change enforcement, and the client has not completed a PKCE/session-hardening
  rollout. Removing an account now invalidates refresh/access-to-data through
  deletion and RLS, but does not implement general non-destructive remote logout
  or disable. The documentation should distinguish those capabilities.
- **F-12 is a limited mitigation:** automatic retention still exposes upcoming
  passes to another user of the same browser. Explicit forget and expiry work;
  stronger shared-terminal privacy requires a deliberate persistence/terminal
  policy rather than treating the retention filter as identity separation.
- **Header trust:** local default/probes are verified. Repository deployment
  notes still describe hosted CF-header trust enabled without a completed
  non-browser spoofing verification. Browser CORS rejection is not proof that
  arbitrary HTTP clients cannot forge a header. No production probe was made.
- **Supplied production version mix:** this review did not inspect it live.
  Given 008 with a pre-008 invite-staff build, administrator invites still call
  the dropped mark_pending_admin RPC and cannot queue that role successfully;
  the older handler's warning/non-admin path is expected from source. Deploying
  the matching Edge build is required, not evidence already supplied by a
  successful SQL migration. Frontend d6a8752 already uses the terms-version RPC
  signature preserved by 008; it does not include the redesign/Arabic changes.
- **Migration qualifications:** permanent fixture data was preserved, but 007
  intentionally clears the old unbound scan cache, and overwritten pre-007
  terms text cannot be reconstructed from hashes. The fixture is not a production
  dump or a large-database lock-duration/load test. No rollback/deploy operation
  was performed on production.

Local testing reused the prepared Docker stack and its previously diagnosed
loopback/proxy accommodations. No secret regeneration was needed. Physical
phone cameras, screen readers, real message-app previews, Google issuer approval,
and a real wallet save remain outside the executed checks. This report makes no
claim that production or newer branch commits have been verified.
