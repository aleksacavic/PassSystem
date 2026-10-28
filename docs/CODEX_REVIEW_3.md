# PassSystem — Codex review 3

Date: 2026-10-29 (Asia/Dubai). Reviewed head: `d6a8752`.
Scope: **only `8a7038e..d6a8752`**, excluding `docs/CODEX_REVIEW_2.md`.
Earlier code was consulted only to understand the changed paths. Production
Supabase and Vercel were not accessed or changed. Application code, checked-in
tests, manifests, and lockfiles were not modified by this review.

## Findings

### R3-01 — Medium: event edits can deadlock with registration

**Status:** verified defect; reproduced against local Postgres.

**Location:** `supabase/migrations/20261028000007_review2_remediation.sql:368`
and the `BEFORE UPDATE` trigger at line 374; registration takes the same capacity
lock before inserting its foreign-key reference to the event.

The new trigger acquires the capacity advisory lock after UPDATE has already
locked the event tuple. A registration acquires the capacity lock first, then
needs a KEY SHARE lock on the event when inserting the registration. The comment
that an UPDATE cannot block KEY SHARE is not generally true: updating the unique
`slug` can take the conflicting FOR UPDATE tuple lock. This creates an actual
cycle, causing one operation to fail with PostgreSQL `40P01`.

**Reproduction:** use a published event E and its current terms version.

1. Session A: `BEGIN; SELECT private.lock_event_capacity(E);`.
2. Session B: update E's slug to a new valid unique slug. Wait until B is blocked
   on the advisory lock; B already holds the event tuple lock.
3. In A, call `register_for_event` for E's original slug with valid input and
   terms version. Its insert waits for the parent-event lock held by B.
4. PostgreSQL detects the cycle. The local probe returned a successful
   registration and **`40P01` for the slug edit**; the selected victim can differ.

The registration call in A ran with an authenticated test user's claims and
role; its explicit capacity-lock acquisition merely makes the ordering
deterministic. The edit is an operation the application supports. This is a
transaction failure, not evidence that Postgres commits a partial registration.

**Suggested fix:** establish one lock order for event writes and registration.
For example, route event edits through a transaction/RPC that acquires the
capacity lock *before issuing UPDATE*, and constrain direct writes accordingly.
A different row-level BEFORE trigger does not move the advisory lock ahead of
the tuple lock. Preserve the fresh event read and avoid reintroducing the
earlier scan/registration lock inversion. Add two-session tests for slug edits
against registration and for interactions with admission and restoration.

### R3-02 — Medium: confirmation can overtake the pending administrator marker

**Status:** verified defect; reproduced with the real trigger and service-role
RPC in separate local transactions.

**Location:** `supabase/migrations/20261028000007_review2_remediation.sql:30`
and line 56; `supabase/functions/invite-staff/index.ts:146`.

The function creates/sends the Auth invitation before marking its pending admin
promotion. The marker's SELECT does not serialize with confirmation. The
transition-only trigger can therefore run its DELETE before the pending row is
inserted. The RPC can still see the uncommitted pre-confirmation Auth row and
insert a marker afterward. Confirmation then commits, leaving a confirmed
non-admin with a pending marker that no later normal email update will consume.
The Edge Function nevertheless reports `admin: true` because the RPC succeeded.
For emailed invitations, the invite can already be accepted while this marking
operation is outstanding. This fails closed for privilege, but loses the
administrator activation the caller requested.

**Reproduction:** create an unconfirmed local account with no pending marker.
In transaction A, update `auth.users.email_confirmed_at` to `now()` and leave A
open after its trigger has run. In session B, call the real service-role
`mark_pending_admin(user_id, inviter_id)` RPC. Then commit A. The local result was:

```text
markError: null
profiles.is_admin: false
pending_admin_invites row still present: true
```

This exercises the database portion of the race directly; it does not claim a
browser email click was timed to win that race during the existing E2E suite.

**Suggested fix:** coordinate marking and confirmation on the Auth user row,
and explicitly handle confirmation that has already happened. Return an actual
promotion/queued/not-applied outcome, rather than unconditional void success,
and make the Edge response reflect it. Keep the one-shot promotion and demotion
cancellation guarantees. Test both orderings, including confirmation held open
after its transition trigger and confirmation committed before marking.

### R3-03 — Medium: a reissued staff link can silently retain administrator rights

**Status:** verified defect; reproduced through the real local Edge Function
and Auth invite redemption.

**Location:** `supabase/functions/invite-staff/index.ts:143` and line 165;
`src/pages/admin/UsersPage.tsx:99` (the pending-account link action passes false).

An administrator invitation leaves a row in `pending_admin_invites`. Reissuing
a link with `admin: false` neither clears nor reports that existing promotion.
The response says `admin: false`, but accepting the replacement link consumes
the old pending marker and makes the person an administrator. The pending user
is shown as ordinary staff until acceptance, so the UI also does not expose this
effective pending role.

**Reproduction:** as an administrator, create a link invitation with
`admin: true`. Before acceptance, create another link for the same email with
`admin: false`. Redeem the replacement token with `verifyOtp`. Both requests
returned 200; the second response contained `admin: false`, while the confirmed
account's actual `profiles.is_admin` was **true**.

This requires an administrator to have authorized the original admin invite;
it is not a way for an unauthenticated recipient to create promotion intent.
The defect is the misleading role result and lack of explicit control over
pending intent when reissuing a link.

**Suggested fix:** define reissue semantics explicitly. If false selects the
new desired role, clear pending promotion transactionally. If reissue preserves
the original role, return and display the effective pending administrator role,
and provide an explicit way to cancel it. Do not report false when the new link
will grant admin. Test administrator-to-staff and staff-to-administrator reissues.

### R3-04 — Low: the new radio control lacks radio-group keyboard behavior

**Status:** verified accessibility defect in the local browser.

**Location:** `src/components/ui/SegmentedControl.tsx:29`.

The component assigns `radiogroup`/`radio` roles to buttons but implements only
click selection. Every option remains in the Tab sequence, and arrow keys do
not move focus or selection as expected for a radio group.

**Reproduction:** on Events, focus the Active radio and press ArrowRight.
Active stays checked. The browser probe reported tab indexes `[0, 0, 0]`.
Keyboard users can still Tab to each button and activate it; the problem is the
announced radio interaction contract, not complete keyboard inaccessibility.

**Suggested fix:** use native named radio inputs with styled labels, or implement
roving tabIndex, wrapped arrow-key navigation, and selection/focus management.
Add keyboard tests for the shared component.

### R3-05 — Low: the scanner's token migration is incomplete

**Status:** verified consistency/requirement gap; no admission-state regression
was observed.

**Location:** `src/pages/scan/ScanPage.tsx:262`, line 276, and line 412.

The changed scanner still uses `bg-black`, `border-white/85`, an arbitrary
`rgba(0,0,0,0.35)` shadow, and `text-white` outside `tokens.css`. In particular the
changed checking-state line combines the new `bg-scrim` token with raw white
text. The requested absence of raw colour classes is therefore not achieved.
These are remaining styles in the token rewrite, not newly introduced scan
authorization defects.

**Reproduction:** search the scanner for
`bg-black|border-white|text-white|rgba\(`; the above matches remain at the reviewed
head. Changing semantic inverse/status tokens cannot restyle those declarations.

**Suggested fix:** define semantic/component tokens for camera background,
frame, mask shadow, and checking-state foreground and use them consistently.
Add a narrow source check for raw component colour utilities. The README's
documented fixed-colour brand artwork and QR-export exceptions should be kept
distinct from ordinary scanner styling; unchanged QR canvas code was not
reported as a new finding.

## Review 2 remediation assessment

| Previous finding | Result at `d6a8752` |
| --- | --- |
| R2-01, repeat promotion after demotion | Original defect closed: legacy app-metadata flags are ignored, pending intent is consumed on confirmation, and explicit demotion cancels it. New marker/confirmation and reissue problems are R3-02/R3-03. |
| R2-02, unbound scan replay | Closed for the tested paths: event and credential are bound, the attempt lock precedes the registration-row lock, conflicting reuse is rejected, and honest retries still replay. Concurrent conflicting uses admit at most one credential. |
| R2-03, accepting unseen terms | Closed for new registrations: exact version required, stale/missing version rejected, checkbox reset on refresh, and new terms versions archived. Completed-request replay correctly precedes a fresh terms requirement and preserves the original consent. |
| R2-04, promotion/deletion race | Closed for the reproduced race. Re-running the previous handler interleaving with a real promotion and Auth DELETE now returned **409**, with the administrator still present. The profile guard acts inside the deletion transaction. |
| R2-05, old retry keys | Closed for tested 003/004 retries. A populated upgrade replay returned the original registration without increasing row count. A 003 request with different attendee details did not replay the original pass. |
| R2-06, stale queued event settings | The queued-archival regression passes, but the claim that event-update lock ordering cannot deadlock is false; see R3-01. |

## Validation

All following suite results are from the reviewed head, without changing or
disabling checked-in assertions:

| Check | Result |
| --- | --- |
| `npm ci` with writable cache | Passed; lockfile unchanged. |
| Test wallet environment generator | Ran; only throwaway local credentials. Edge integration used the whole service-account JSON configuration without the old separate key fields. |
| Typecheck / lint | Passed. |
| Unit/component suite | **68 passed**, 14 files. |
| Integration suite | **108 passed**, 10 files. |
| Playwright workflow suite | **9 passed** using installed Chromium and the existing ignored local config override. |
| Production build / bundle-secret scan | Passed; no privileged secrets detected in 20 built files. |
| Migration 007 on the existing populated local 006 database | Applied successfully. |
| Independent rolled-back populated upgrade fixture | Preserved original registration data, admitted status/logs, profile confirmation, and staff assignment; imported legacy unconfirmed admin intent, consumed it once, ignored a confirmed user's stale flag, and replayed legacy registration without adding a row. |

Independent probes reproduced R3-01 through R3-04. R3-05 was verified by source
search. They were temporary ignored helpers; only this report is committed.

The local machine reused the previously prepared Supabase stack, including its
flattened official Postgres filesystem and local Edge Runtime proxy exclusions.
The generated Edge entrypoint and local throwaway wallet environment were
preserved/refreshed when recreating that test container. Auth's BusyBox health
probe still has the previously diagnosed loopback-proxy issue; actual Auth calls
and the full local test suites worked. The pinned Playwright download remains
unavailable under this environment's network policy, so the browser run used
installed Chromium, not the exact downloaded Playwright revision. These are local
test-environment qualifications, not production changes or application findings.

## Additional checks found sound

- **Invite authorization and delivery:** caller JWT verification and server-side
  administrator checks remain in place for both delivery modes. Non-admin
  rejection passes. Generating a link sends no email. The returned credential
  is in `/invite#token=...`, not a query parameter; ordinary HTTP requests and
  referrers omit that fragment. The application does not log the returned token.
- **Redemption, replacement, expiry:** merely loading the invite page made zero
  verify requests and left the account unconfirmed. Explicit Accept made one
  request. Reuse was rejected by E2E; independently, the old replaced token was
  rejected and its replacement worked. Backdating the local confirmation token
  beyond the configured lifetime produced `otp_expired`.
- **Already signed in:** an independent mobile browser check opened B's link
  while signed in as A. It showed the identity-switch warning and did not redeem
  automatically. Accept switched to B's visible Account identity, marked
  password setup as required, and removed the token from the address bar.
- **Pending promotion privileges:** the private table and service-role-only
  marker are not writable through ordinary authenticated/anonymous API calls.
  The old editable-user-metadata path does not promote users. See R3-02/R3-03
  for the remaining lifecycle defects rather than a claim that the whole
  pending-invite lifecycle is correct.
- **SQL authorization:** the new SECURITY DEFINER functions pin search_path.
  New private tables revoke ordinary-role access. The new registration signature
  revokes default execute privileges before granting the intended public roles.
  No privileged wallet/private key is added to client configuration or imports.
- **Legacy replay:** 003 compatibility additionally compares stored attendee
  names, email, and empty phone; 004 hashes already bind the corresponding
  request details. Lookup is event-scoped and phone-bearing requests do not use
  phone-less legacy fallback. No new route for a changed-body requester to
  receive the earlier attendee's credential was demonstrated.
- **Wallet JSON:** unit tests cover whole-JSON parsing, malformed/missing
  settings, and fallback fields. Only email/key fields are consumed; JSON does
  not choose an arbitrary network endpoint. Real local integration verifies the
  signed link with the throwaway public key. Google issuer approval and a real
  wallet save were not tested.
- **UI state and semantics:** scanner success/rejection/amber/error and main
  registration workflows pass their existing tests under the preview CSP.
  Mobile inspection found one visible Main navigation landmark, the correct
  `aria-current="page"` for Events and Account, and an accessible Sign out icon
  button. IconButton supplies a label/title and hides its decorative icon.
  Semantic/component tokens are emitted and the build succeeds; the remaining
  scanner colour exceptions and radio keyboard issue are listed separately.

## Migration and rollout limits

007 preserves permanent application data in the tested populated fixture, but
it is not a backward-compatible/no-interruption rollout:

- It intentionally truncates old unbound scan-attempt cache rows. A pre-upgrade
  uncertain scan loses that cached response; this does not delete admission
  history or undo a check-in.
- Historical terms text already overwritten before 007 cannot be recovered
  from its old hash. The backfill archives current terms; subsequent edits are
  archived, but the migration does not reconstruct missing pre-007 text.
- The new registration parameter and required terms version need the matching
  frontend. Old open registration pages cannot supply that version. Conversely,
  the new frontend/marker RPC cannot be assumed compatible with schema 006.
  Follow the documented coordinated cutover and account for refreshing older
  pages; no production compatibility claim was established by these local tests.
- The fixture is not a production data dump or load/DDL-lock-duration test.
  The event-edit deadlock in R3-01 remains an application concurrency blocker
  despite successful application of the migration itself.

Missing regressions include the three lifecycle/lock interleavings above,
pending-role visibility during reissue, radio keyboard operation, and a narrow
token-usage check. Production configuration, physical cameras, real message-app
preview behavior, screen-reader interaction, and a real Google Wallet save were
not exercised. No production deployment or migration was performed.
