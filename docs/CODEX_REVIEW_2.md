# PassSystem — Codex review 2

Review date: 2026-10-28. Scope: **only** the 11 commits in
`9918dc4..8a7038e` on `claude/passsystem-implementation-h1i74q`.
Reviewed head: `8a7038e`. Earlier code was read only where necessary to understand
the changed code, privileges, foreign keys, and upgrade behavior. Production
Supabase and Vercel were not accessed or changed. No application code, tests,
dependency declarations, or lockfiles were changed for this review.

## Findings

### R2-01 — High: an accepted administrator invite can restore revoked administrator rights

**Status:** verified defect, reproduced against the local Auth trigger.

**Location:** `supabase/migrations/20261028000004_audit_remediation.sql:519`
and `supabase/functions/invite-staff/index.ts:119`.

The invite function writes `raw_app_meta_data.pending_admin = true`. The Auth
trigger grants administrator rights whenever that flag is true and the account
is confirmed, but never consumes the flag. `set_user_admin(..., false)` changes
only the profile. A subsequent email change or app-metadata update runs the
trigger again and silently restores administrator rights. The trigger is not
restricted to the transition from an unconfirmed to a confirmed account.

**Reproduction:** invite an administrator and accept the invite; have another
administrator demote that account using `set_user_admin`. Complete an email
change on the demoted account. The Auth email update invokes the trigger and
`profiles.is_admin` becomes true again. A local SQL probe of the exact trigger
path can use a confirmed account with the real `pending_admin` app-metadata flag,
demote it through the RPC, then update its `auth.users.email` and inspect its
profile. The email change itself does not require administrator privileges.

**Suggested fix:** make pending promotion a single-use, transactional operation
on invite acceptance. Consume the flag, clear stale flags for already-confirmed
accounts, and ensure explicit demotion cancels any pending promotion. Add a
regression test that accepts an administrator invite, demotes the account, and
changes its email without restoring its administrator rights.

### R2-02 — Medium: scan replay is not bound to the submitted credential

**Status:** verified defect, reproduced through the local RPC.

**Location:** `supabase/migrations/20261028000004_audit_remediation.sql:358`
and `supabase/migrations/20261028000004_audit_remediation.sql:431`.

The cached response is selected by operator and attempt ID, and checked only
against the event. No token hash is stored or compared. Consequently a request
with a different, malformed, unknown, or wrong-event credential can receive a
previous `admitted` response. The cached return precedes the invalid/revoked/
wrong-event decisions. This violates the server-side validation contract even
though it requires an authenticated operator and knowledge of that operator's
attempt ID; it is not an anonymous authorization bypass.

**Reproduction:** as an assigned operator, admit token A for event E with attempt
UUID X. Call `admit_pass(E, 'NOT-A-PASS', X)`. It returns the original attendee's
`admitted` response with `replayed: true`, instead of rejecting the credential.
Using token B instead can likewise return A's result without admitting B.

There is a related keying defect: the primary key is `(operator_id, attempt_id)`,
although the implementation/test describes attempts as per event. Reusing X for
another event proceeds, but `ON CONFLICT DO NOTHING` prevents caching that event's
result. Two different credentials using X concurrently also lock different
registration rows and can both proceed before the cache insertion conflict.

**Suggested fix:** bind each attempt to event and normalized credential hash;
reject mismatched reuse. Serialize the attempt before processing it and use a
key consistent with the intended event scope. Preserve the legitimate timeout
retry behavior. Test changed tokens, invalid tokens, two events, and concurrent
conflicting uses of one attempt ID, including the subsequent retry.

### R2-03 — Medium: consent can be recorded for terms the attendee never saw

**Status:** verified defect, reproduced through the local public API.

**Location:** `supabase/migrations/20261028000006_terms_and_phone.sql:189`
and `supabase/migrations/20261028000006_terms_and_phone.sql:262`;
`src/pages/public/RegisterPage.tsx:83`.

The browser submits only a boolean, not the hash/version of the terms displayed.
The database hashes its current event text. If the organizer edits the terms
after the page loads, an attendee accepting text A can receive a registration
whose evidence says they accepted text B. Computing SHA-256 correctly does not
establish that the hashed text was shown. The schema also retains only the
current editable text, so older accepted text is not recoverable from the hash
alone after edits.

**Reproduction:** load the public event while `terms_text = 'Terms A'`; update it
to `'Terms B'` in another session; submit the unchanged form with
`p_accept_terms = true`. The registration succeeds and its `terms_hash` equals
SHA-256 of B, although the browser displayed A.

**Suggested fix:** return an immutable terms version or digest with the public
event and require that exact version/digest with acceptance. Reject a changed
version and refresh the form with an unchecked checkbox. Synchronize the version
check and insert, preserve historical terms text/version, and define replay
behavior across terms changes. Test edits between display and submission and
terms-required changes during retries.

### R2-04 — Medium: administrator promotion can race past remove-staff's protection

**Status:** verified defect, reproduced with a deterministic handler interleaving
and real local Auth/Postgres operations.

**Location:** `supabase/functions/remove-staff/index.ts:64` through the DELETE
at line 70; related promotion lock in
`supabase/migrations/20261028000004_audit_remediation.sql:598`.

The target's `is_admin` value is fetched in a separate HTTP request before the
service-role Auth deletion. Promotion can commit between those operations.
The Auth deletion does not repeat the check and does not participate in the
advisory lock used by `set_user_admin`. Thus a target who is an administrator at
deletion time can still be deleted, contrary to the endpoint's stated policy.
This requires concurrent administrator operations, not a non-admin caller.

**Reproduction:** pause remove-staff after it has fetched a non-admin target
profile. Promote that target through `set_user_admin(target, true)` from another
administrator session, then resume the DELETE. The endpoint deletes the newly
promoted administrator. A deterministic probe can delay delivery of the real
target-profile response, perform the real promotion, then return that previously
read response and let the unmodified handler perform the real Auth DELETE.

**Suggested fix:** enforce the non-administrator restriction inside the actual
deletion transaction, synchronized with promotion/demotion (for example, a
database deletion guard sharing the administrator advisory lock). A lock acquired
and released in an earlier standalone RPC cannot cover the later Auth HTTP call.
Add a two-session promotion/deletion regression test. Keep the existing direct
self-removal and administrator rejection tests.

### R2-05 — Medium: the upgrade changes retry hashes without preserving existing retries

**Status:** verified defect, reproduced by applying the real migrations to a
populated local fixture inside a rolled-back transaction.

**Location:** `supabase/migrations/20261028000004_audit_remediation.sql:213`
and `supabase/migrations/20261028000006_terms_and_phone.sql:200`.

Migration 004 replaces the original request-UUID hash with a hash including
names and email. Migration 006 changes it again by appending a separator and
phone, even when the phone is absent. Existing rows retain their old hashes.
Neither migration nor the new RPC has compatibility lookup. An identical retry
of a successful registration made before either upgrade is treated as a new
registration, producing a duplicate attendee or an erroneous `event_full`
response. Existing passes survive; existing in-flight retry guarantees do not.

**Reproduction:** on schema 001–003, register with UUID X and fixed details;
apply 004 and retry the same body/X. It inserts another row with
`replayed: false`. Apply 005–006, retry the same request with no phone and
`p_accept_terms = true`; it inserts a third row. This can be exercised entirely
inside a rolled-back transaction using populated fixtures.

**Suggested fix:** version the stored retry-key format and provide compatible
lookups during at least the replay window. For legacy UUID-only hashes, compare
the stored normalized attendee details before returning/rotating a credential;
do not reintroduce the cross-body replay vulnerability fixed by F-04. Recognize
the 004 format when upgrading to 006. Add populated-database upgrade tests and a
capacity-one example where a lost response must still be recoverable.

### R2-06 — Low: queued registrations keep event settings read before the capacity lock

**Status:** verified behavior; a concurrency-policy risk, not proof that the
fixed-capacity registration race permits oversubscription.

**Location:** `supabase/migrations/20261028000004_audit_remediation.sql:194`
and `supabase/migrations/20261028000006_terms_and_phone.sql:184` through line 198.

Replacing the event-row lock with an advisory lock decouples registration from
event updates. The RPC reads status, capacity, and terms before waiting for that
lock and does not refresh the event afterward. Administrator edits do not acquire
the same advisory lock. A queued request can therefore issue a new pass after
archival has committed, using the earlier published-event snapshot. Whether an
already-started request should survive archival needs an explicit policy; the
current implementation does so silently. The consent-version defect in R2-03
exists even without this queueing interleaving.

**Reproduction:** session A begins a transaction and calls
`private.lock_event_capacity(E)`. Start an anonymous registration in session B;
wait until `pg_stat_activity` shows it waiting on the advisory lock. In session C,
archive E and commit. Commit A. B returns `ok: true` and creates a registration
despite the committed archived state. This was reproduced locally.

**Suggested fix:** define and test the event-edit/registration ordering. If
archival and settings changes must govern pending registrations, synchronize
relevant event updates with the capacity lock and reload the event after
acquiring it. Preserve the scan/registration deadlock fix rather than blindly
restoring the old event-row locking order. Add tests for queued archival,
capacity edits, and terms changes.

## Validation and checks found sound

The commands ran against `8a7038e`, with only the report added to tracked files.
No test was disabled or assertion changed. Independent probes were temporary,
git-ignored helper files, not replacement tests.

| Check | Result |
| --- | --- |
| `npm ci --cache /tmp/passsystem-npm-cache` | Passed with the checked-in lockfile unchanged. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed. |
| `npm run test` | **64 passed**, 14 files, including wallet signature tests. |
| `npm run test:integration` | Final run: **95 passed**, 9 files; no skipped wallet tests. |
| Playwright workflow suite | **8 passed**, using the existing installed Chromium through an ignored config override. |
| `npm run build` | Passed. |
| `npm run check:bundle-secrets` | Passed: no privileged secrets detected in 16 built files. |
| Populated 001–003 → 004 → 005 → 006 fixture | Applied successfully; original registrations, staff assignments, and admission history preserved; confirmed profiles backfilled correctly. Historical registrations retain null phone/consent fields. Retry compatibility fails as R2-05 describes. The fixture transaction was rolled back. |

Independent probe outcomes:

- R2-01: `is_admin` changed `false → true` after the Auth email-update trigger ran
  on a demoted account retaining `pending_admin`. This directly exercised the
  database trigger; the browser email-confirmation workflow was not separately
  tested for that finding.
- R2-02: a real RPC call with `NOT-A-PASS` and the previous successful attempt ID
  returned `result: admitted, replayed: true`.
- R2-03: after public lookup of A followed by an organizer edit to B, registration
  succeeded and the stored hash matched the unseen B.
- R2-04: the unmodified remove-staff handler was loaded under Node with a
  `Deno.serve` shim. The real target-profile HTTP response was delayed while a
  real promotion RPC committed. The real Auth DELETE then returned 200 and the
  newly promoted account no longer existed. This was a controlled handler-level
  race reproduction, not a claim that the existing Edge integration suite
  exercises that interleaving.
- R2-05: identical registration requests produced **1 → 2 → 3 rows**, with
  `replayed: false` after both upgrades.
- R2-06: the registration blocked behind the capacity lock returned `ok: true`
  after a separate session had committed archival.
- An event operator could not read the new phone/consent data through RLS (zero
  rows). An authenticated administrator selecting `terms_hash` received `42501`.
  Catalog inspection found no unpinned SECURITY DEFINER functions in the
  application schemas.

The following changed behavior was checked and found sound, subject to the
specific defects above:

- **Edge authorization:** invite/remove validate the caller JWT through Auth's
  `/user` endpoint and read the administrator flag server-side. They do not trust
  a submitted user ID, decoded-only JWT claims, or editable user metadata.
  Anonymous/non-admin rejection and normal administrator operations pass the
  integration tests. Direct administrator deletion and self-removal are refused
  without the R2-04 interleaving. Pending invites can be canceled.
- **Service-role isolation and CORS:** privileged credentials remain in the Edge
  runtime; the browser calls the functions using its session. No new privileged
  key is introduced into Vite configuration or client imports. Wildcard CORS is
  not itself an authentication bypass here: administrator endpoints require a
  bearer session and do not authorize using browser cookies. Public wallet
  access intentionally uses possession of the pass token.
- **Database privileges:** the replaced public RPCs revoke default PUBLIC/anon
  access and grant the intended roles. `wallet_pass_data` is service-role-only;
  its denial to anon and authenticated administrators passes. New phone/consent
  column grants retain existing registration RLS, without exposing credential
  hashes or granting direct registration writes. New private helpers and
  `scan_attempts` are not directly available to ordinary clients.
- **Admission and capacity:** the existing real-database race tests pass for
  normal admission, scan retries using the same credential, and fixed event
  capacity, including the 30-request/capacity-five regression. Row locking still
  protects the registered-to-checked-in transition. Capacity-aware restoration
  and wrong-event log redaction also pass. The new false-green issue is the
  cached-response binding, not a demonstrated double update of one registration.
- **Wallet:** the lookup normalizes and hashes the supplied credential, refuses
  unknown/revoked passes, and does not grant public access to the privileged RPC.
  RS256 signatures verify using the throwaway public key. The claims and QR
  contain the expected pass URL, and reissue versions change wallet object IDs.
  The browser accepts only the expected Google origin. E2E verifies the signed
  redirect and iPhone button suppression, not Google's acceptance of a real
  issuer's ticket or a physical-device wallet save.
- **Terms and phone:** missing required acceptance is rejected, new consent
  timestamps and SHA-256 values are stored, and operator edits to terms are
  denied. Ordinary ASCII phone formatting is normalized consistently, and
  invalid E.164 shapes are rejected. The browser normalizes before submitting.
  The helpers are not identical for every whitespace input: direct RPC
  `p_phone = E'\t'` is rejected, while the browser treats that input as blank and
  submits null. A shared whitespace/Unicode boundary test matrix is advisable;
  this is not a demonstrated bypass in the normal browser flow.
- **Removal history:** the integration test verifies that deleting an operator
  removes their profile and assignments, keeps registrations/check-in timestamps
  and admission logs, and clears the Auth-user foreign-key references. The
  surviving access token no longer reads the event through RLS. Historical actor
  attribution becomes null as documented; this does not undo admission.
- **Frontend remediation:** same-origin redirect normalization, scanner remount
  on event change, timeout retry ID reuse, refusal to show green for network or
  denied responses, DST-gap rejection, and pass-list expiry/removal have passing
  coverage. The narrower production CSP was reviewed; the main browser workflow
  runs under the local production-preview CSP.

## Remaining test gaps and limits

The passing suites do not establish that the findings above are fixed. Add the
specific regressions named in each entry; in particular the existing F-01 tests
reuse the same token, the consent tests hash the current text without an edit
between display and submit, and removal tests exercise sequential guards rather
than promotion/deletion races. The checked-in tests also lack populated upgrade
coverage for the retry-key format changes.

Further useful tests are concurrent *identical* registration retries and
response reordering, auth/account-change tests following administrator invite
acceptance, Unicode phone boundaries, and wallet rejection of a superseded
token after reissue. The new public wallet endpoint has no application-level
rate limiter; repeated lookup/signing requests are an availability/cost risk to
evaluate with the deployment's edge controls, not a demonstrated token-guessing
or signature-forgery vulnerability.

Local execution required environment workarounds, without changing tracked
application/configuration files:

- npm's default cache and Supabase CLI configuration writes conflicted with the
  filesystem sandbox; a writable npm cache and approved CLI execution were used.
- Docker's `vfs` storage driver ran out of space unpacking the many-layer
  Postgres image. The same official Postgres filesystem was exported and imported
  as a flattened local image. Its environment, entrypoint, command, working
  directory, exposed ports, stop signal, and health check were verified against
  the original image configuration. The managed Docker driver was unchanged.
  Download/TLS/checksum verification was not disabled.
- The injected proxy intercepted container-local requests. Edge Runtime local
  proxy exclusions were added while retaining its generated entrypoint,
  configuration, mounts, and credentials. Initial integration attempts failed
  during this environment diagnosis; **95/95 passed after correction**.
- BusyBox wget ignored proxy exclusions for Auth's loopback health check. The
  stack was kept running with the CLI's supported `--ignore-health-check` flag;
  the actual local Auth endpoint returned HTTP 200, and the same check using
  `wget -Y off` against loopback succeeded. The failed Docker health indicator
  was not treated as evidence of working application behavior; the API and full
  test results provide that evidence.
- The pinned Playwright browser download was blocked by network policy. An
  ignored Playwright config selected installed **Chromium 154.0.8037.57** and
  otherwise retained the checked-in suite, production build, CSP, and assertions.
  The exact pinned downloaded browser was not tested.

These checks do not validate production configuration, real-device camera
behavior, Google issuer approval, large-database migration lock duration, or a
production data dump. They intentionally made no production requests or changes.
