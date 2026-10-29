# PassSystem: Independent Audit #1 and Remediation

Audit date: 2026-10-28. Commit audited: `9918dc4`; `c6cc1b5` (invite Edge Function) by code review only.

The auditor was a separate Claude agent started with a clean context. It was given the Codex brief from
`CODEX_HANDOVER.md` and told not to trust the implementation or its documentation. It attacked the live local
stack with its own probes and tests. **This is not the Codex review.** The owner will run Codex next, against the
remediated head.

## Auditor's summary

- No critical findings.
- Confirmed sound, and re-verified by the auditor's own probes:
  - **Event isolation and hashes:** no cross-event leak; credential hashes are unreachable through PostgREST (select, filter, order, cast, embedding).
  - **Permissions:** EXECUTE privileges are exactly as documented.
  - **Single admission:** exactly-once admission holds under every interleaving tried (admit/admit, reissue/admit, revoke/admit, admit/reissue).
  - **Capacity:** holds under 30 concurrent registrations.
  - **Scanner:** never shows green without a server `admitted`.
- Findings: **2 High, 3 Medium, 12 Low** (17 total).

## Findings and fixes

All database changes are in `supabase/migrations/20261028000004_audit_remediation.sql`. Migrations 001–003 are
already deployed and are not edited. Every fix has a regression test that fails on the old code. Several were
mutation-checked: the fix was temporarily reverted to confirm the test fails.

| ID | Sev. | Finding | Fix | Test |
| --- | --- | --- | --- | --- |
| F-01 | High | A scan the client timed out on, but the server committed, showed red "ALREADY USED" on Retry, so a legitimate attendee could be turned away | `admit_pass(event, token, attempt_id)`. The scanner sends one attempt id per detected credential and reuses it on Retry. The server stores each attempt's response (`private.scan_attempts`, per operator and per event), and a retry returns the original result with `replayed: true`. The UI shows green **ADMITTED** with "Confirmed on retry". A new scan still gets "already used". | `audit-regressions` F-01 (lock-held timeout reproduction), `ScanPage.test` F-01 |
| F-02 | Medium | `cf-connecting-ip` was trusted by default and is forgeable off Cloudflare; the tests forced the flag off and hid this | Default is now `0` for every install. Supabase Cloud switches it on after the new Staff page **Test header spoofing** check confirms the proxy replaces forged values. The test setup no longer overrides it. | `audit-regressions` F-02, E2E spoof check |
| F-03 | High | Registration abuse: IPv6 per-address buckets, an event-wide limiter that rotating addresses can exhaust, and capacity filled by junk | **Partly fixed:** IPv6 clients are grouped by /64. **Open:** CAPTCHA (Cloudflare Turnstile) needs a Turnstile site and secret key from the owner (recommended before large public events), plus organizer bulk-revoke tooling. | `audit-regressions` F-03 |
| F-04 | Medium | Replaying a request id with different names returned (and rotated) the earlier person's pass | The idempotency hash now covers the request id together with the normalized names and email. A different body is a new registration; an identical replay still returns the same one. | `audit-regressions` F-04 |
| F-05 | Low | `restore_registration` could exceed `max_attendees` | Takes the per-event capacity lock, counts, and raises `event_full` | `audit-regressions` F-05 |
| F-06 | Low | Registration's `FOR UPDATE` on the event row blocked scans on the same event, with a theoretical deadlock against replays | Replaced by a per-event transaction advisory lock (`private.lock_event_capacity`) | `audit-regressions` F-06 (registration completes while an admission is open); capacity under 30 concurrent requests |
| F-07 | Low | Wrong-event log rows exposed another event's registration and event ids to the scanning event's organizers | `registration_id` and `pass_event_id` are logged only when the scanner is also staff of the pass's event | `audit-regressions` F-07 (both directions) |
| F-08 | Medium | Unconfirmed accounts could be assigned as staff; administrator invites granted admin before acceptance | `profiles.confirmed_at` is kept in sync by trigger. `add_event_staff` and `set_user_admin(true)` require a confirmed account. Administrator invites set `app_metadata.pending_admin` (writable only with the service role), and the trigger grants admin on confirmation. The Staff page shows **Invite pending** and warns if public sign-up is ever switched back on. | `audit-regressions` F-08 (3 tests incl. self-set `user_metadata`), `invite.test` |
| F-09 | Low | Two admins demoting each other concurrently could leave zero admins | A global advisory lock and a "at least one admin must remain" check (`last_admin`) | `audit-regressions` F-09 (two-session race) |
| F-10 | Low | Invisible and bidi-control characters were accepted in names | Rejects U+200B–200F, U+202A–202E, U+2060–206F, U+FEFF and U+00AD. Requires a letter or digit. NFC normalization. Mirrored client-side. Real names in Latin, Cyrillic and CJK scripts, apostrophes and hyphens still pass. | `audit-regressions` F-10 (both directions), `validation.test` |
| F-11 | Low | `?next=/%09/host` passed `safeNext`, and React Router then crashed with a stack trace | `safeNext` resolves the value with `URL` and keeps only same-origin paths. A root `errorElement` shows a friendly error page. | `nav.test` (tab, newline, backslash, `javascript:`) |
| F-12 | Low | Passes saved on a shared or kiosk device were listed to the next person | Stored passes expire 3 days after the event starts. The pass page has **Remove this pass from this device**. | `passStorage.test` |
| F-13 | Low | Switching `/scan/A` → `/scan/B` kept A's header while scans went to B | The scanner is remounted per event (`key={eventId}`) | `ScanPage.test` F-13 (mutation-checked) |
| F-14 | Low | Racing camera starts could leak a stream; resume forgot the chosen camera | Start/stop generation counter: stale starts stop their own stream. The selected device is remembered for resume. | Code review (camera hardware cannot run in unit tests) |
| F-15 | Low | CSP allowed any `*.supabase.co` | `connect-src` is pinned to `https://wvwpedmwhsddsfixjpjd.supabase.co`, and the unused `wss:` source is dropped | E2E asserts no CSP violations |
| F-16 | Low | Session hardening for shared door phones (PKCE, secure password change, remote sign-out) | **Deferred.** Recommended: enable "Secure password change" in Supabase Auth. PKCE would change the invite and recovery link flow and needs its own test pass. Remote sign-out and disabling a user need an admin Edge Function. | — |
| F-17 | Low | Wall-clock times that don't exist because of DST were converted silently and inconsistently | The event form rejects such times with a clear message | `eventForm.test` |

### Also changed as part of this round
- **The invite Edge Function no longer has any third-party imports.** It calls Supabase Auth and PostgREST over
  `fetch`, so nothing is downloaded when it boots. The local edge runtime couldn't fetch the npm package through
  the sandbox proxy, and a dependency-free function avoids that whole class of failure.

## Open items

1. **CAPTCHA for public registration (F-03).** Needs a Cloudflare Turnstile site key (public) and secret key
   (server-side secret) from the owner.
2. **Session hardening (F-16).** See the table above.
3. **Real-device camera checks for F-14.** Camera selection on multi-lens phones.
4. **Codex review** against the remediated head.

## Test results after remediation

| Suite | Result |
| --- | --- |
| Typecheck, lint | clean |
| Unit and component tests | 49 / 49 |
| Integration tests (local Supabase incl. edge runtime and Mailpit) | 79 / 79, including 18 audit regression tests and 7 invite tests |
| E2E (Playwright, production build and CSP) | 7 / 7 |
| Build and bundle secret scan | clean |

## Codex review 2 remediation (migration 007)

Findings from `docs/CODEX_REVIEW_2.md`, fixed in `supabase/migrations/20261028000007_review2_remediation.sql`, the
`invite-staff` and `remove-staff` Edge Functions and the registration page. Each has a regression test in
`tests/integration/review2-regressions.test.ts`.

| ID | Severity | Fix |
| --- | --- | --- |
| R2-01 | High | Pending administrator promotions move to `private.pending_admin_invites` (written only through the service-role RPC `mark_pending_admin`). The Auth trigger grants rights only on the unconfirmed → confirmed transition and deletes the pending row. Demotion also deletes it. The old `app_metadata.pending_admin` flag is ignored; unconfirmed invites that carried it were copied into the table. |
| R2-02 | Medium | `private.scan_attempts` stores the event and a hash of the submitted credential (raw input when it isn't a valid pass). Uses of one attempt id are serialized with an advisory lock. A replay requires the same event and credential; anything else fails with `attempt_conflict`. Old cache rows (seconds-long retry aids) were dropped. |
| R2-03 | Medium | The public event carries `terms_version` (SHA-256 of the text). The browser sends it back; a different or missing version returns `terms_changed` with the current event, and the form reloads the text and clears the checkbox. Every version of an event's terms is kept in `private.event_terms_versions`, keyed by the hash stored on the registration. A retry of a completed registration still returns its pass after a terms edit. |
| R2-04 | Medium | A `BEFORE DELETE` trigger on `profiles` refuses to delete an administrator inside the deleting transaction (the Auth cascade), ordered against `set_user_admin` by the profile row lock. `remove-staff` reports `remove_admin_first` when that happens. Maintenance SQL can bypass it with `set local passsystem.allow_admin_delete = 'on'`. |
| R2-05 | Medium | Retries also match the 004 key format (no phone) and the 003 format (request id only, then the stored names, email and empty phone must match too), so a retry that straddles an upgrade returns the original pass. |
| R2-06 | Low | Event updates take the event's capacity lock (trigger), and `register_for_event` re-reads the event after acquiring it. A registration queued behind an archival or a settings change sees the new state. Registration inserts take only a KEY SHARE lock on the event row, which an UPDATE does not block, so the lock orders cannot deadlock. |

Also from the review: whitespace-only phone input is treated as "no phone" in the database, matching the browser.

Not changed: the public `google-wallet` function has no application-level rate limit. It only answers for a valid
pass token and costs one signature per call. Revisit if Supabase usage shows abuse.

Results after this remediation: unit 68 / 68, integration 108 / 108 (11 new regression tests), E2E 9 / 9.

## Codex review 3 remediation (migration 008)

Findings from `docs/CODEX_REVIEW_3.md`. Database fixes are in `supabase/migrations/20261028000008_review3_remediation.sql`; tests are in
`tests/integration/review3-regressions.test.ts`, `src/components/ui/SegmentedControl.test.tsx` and `src/styles/tokens.test.ts`.

| ID | Severity | Fix |
| --- | --- | --- |
| R3-01 | Medium | The 007 `BEFORE UPDATE` capacity-lock trigger is dropped, so event edits take no advisory lock. `register_for_event` re-reads the event `FOR SHARE` after the capacity lock: it waits for an in-flight edit and sees its result, and a later edit waits for the registration. `FOR SHARE` doesn't conflict with the `KEY SHARE` locks of admissions and other registrations. Tests: slug change against a held capacity lock, registration during an uncommitted slug change, archival in both orders. |
| R3-02 | Medium | `mark_pending_admin` is replaced by `set_pending_admin(user, admin, invited_by)`. It locks the Auth user row first, which orders it against the confirming update. If the invite was accepted in the meantime, it grants the rights directly. It returns `queued`, `granted`, `cleared`, `unchanged` or `not_found`, and `invite-staff` reports the effective role from that. |
| R3-03 | Medium | The latest invite decides the role: `invite-staff` sets or clears the pending promotion on every invite, email or link. The Staff page loads `pending_admin_invites()` (administrators only), shows **Admin invite** on such rows, and keeps that role when it creates a fresh link. |
| R3-04 | Low | `SegmentedControl` is one Tab stop (roving `tabIndex`). Arrow keys move and select with wrap-around, Home/End jump to the ends. |
| R3-05 | Low | Scanner colours use new tokens (`bg-camera`, `border-camera-frame`, `shadow-camera-mask`, `text-on-inverse`). `src/styles/tokens.test.ts` fails on raw palette utilities, arbitrary colour values or hex colours in components. The Google Wallet button is the one documented exception (brand artwork). |

Rollout: apply 008, then deploy `invite-staff` right away, because 008 drops `mark_pending_admin`, which the previous function version calls. Then deploy the frontend (it calls `pending_admin_invites`). 008 doesn't change the `register_for_event` signature, so open registration pages keep working.

Results after this remediation: unit 72 / 72, integration 116 / 116, E2E 9 / 9.

## Codex review 4 remediation (migration 009)

Findings from `docs/CODEX_REVIEW_4.md`. Database fixes are in `supabase/migrations/20261029000009_review4_remediation.sql`; tests are in
`tests/integration/review4-regressions.test.ts`, `src/scanner/useCameraScanner.test.ts`, `src/lib/i18n.test.ts`,
`src/pages/public/RegisterPage.test.tsx`, `src/lib/calendar.test.ts` and `src/lib/securityHeaders.test.ts`. The tests that reproduce a
finding were run against the previous code (or that code's behaviour restored in the local database) and failed there. Two are invariant
guards that passed before the fix as well: unmounting mid-start (R4-02) and "the creator cannot be changed" (R4-03). The R4-07 tests target
the historical `9918dc4` generator, not a change made in 009.

| ID | Severity | Fix |
| --- | --- | --- |
| R4-01 | Medium | Every invite reserves a generation for its email address (`begin_invite`) **before** Supabase Auth issues the link. `set_pending_admin(user, admin, generation, invited_by)` applies the role only while that generation is current; otherwise it returns `stale` and changes nothing, and `invite-staff` answers `409 invite_superseded` without a link. A queued promotion records its generation, and the acceptance trigger honours it only if it is still current. Demotion (`set_user_admin`) advances the generation, which voids every invite request still in flight. Locks per path (corrected in review 5): see the R5-01 entry below. Tests: both of Codex's interleavings, an invite's own late save after acceptance and demotion, a queued promotion overtaken by a newer accepted invite, and the real Edge Function held at the role step while a newer invite is reserved. |
| R4-02 | Medium | The camera request is kept on its own. Whatever happens to a start (detector failure before or after the camera answers, a newer start, a stop), a stream it obtains is stopped unless it became the active one. Unmounting also advances the start generation. Tests cover both failure orders and unmounting mid-start. |
| R4-03 | Medium | `validate_event` still refuses to change an event's creator to another account, but now allows clearing it, so `ON DELETE SET NULL` works when the creator's account is deleted. The trigger cannot tell that foreign-key action from a privileged `SET created_by = NULL`; ordinary users cannot write the column and no function writes it, so a future privileged function that does would need its own check. The test deletes a demoted creator who also assigned staff and scanned a guest, and checks every column that references Auth users. |
| R4-04 | Low | Unknown API error codes show an approved, translated generic message (`error.generic`); server text is never rendered on guest pages. The registration and pass pages store the error code and translate it when shown, so switching language updates it. |
| R4-05 | Low | Calendar text turns CRLF, lone CR and LF into an escaped newline and drops the other control characters that iCalendar TEXT values cannot contain. |
| R4-06 | Low | 003-era retries compare the stored names after NFC normalization, so a name stored with a decomposed accent replays its existing registration. |
| R4-07 | Low | `src/lib/securityHeaders.test.ts` asserts the default `connect-src` (only `'self'` and the pinned project), the absence of wildcard, scheme-wide and WebSocket sources, and that `vercel.json` and `netlify.toml` deploy exactly the generated headers. All three cases fail with the `9918dc4` generator. The browser workflow keeps its no-violations check. |

Rollout: apply 009, then deploy `invite-staff` right away. 009 replaces `set_pending_admin` with a four-argument version, so the function
currently deployed (v7) can't save roles until it's updated: an administrator invite is then sent as a staff invite with a warning, as before 008's
deploy. Then deploy the frontend. 009 doesn't change the `register_for_event` signature.

Codex's residual risks, unchanged by this round: F-03 stays partial (no CAPTCHA, no protection against rotating networks), F-16 stays deferred (see
below), and F-12 is a convenience filter, not identity separation on a shared browser. "Forget this pass" only removes it from the device; the pass
itself stays valid. Deleting a staff account removes their access (RLS and Auth), but that is not the same as a general remote sign-out or a
non-destructive disable, which F-16 would add. Hosted `cf-connecting-ip` trust still needs to be confirmed with a non-browser request.

Results after this remediation: unit 86 / 86, integration 124 / 124, E2E 9 / 9.

## Codex review 5 remediation (migration 010)

Findings from `docs/CODEX_REVIEW_5.md`. The database change is `supabase/migrations/20261029000010_review5_remediation.sql`; tests are in
`tests/integration/review5-regressions.test.ts`, `src/scanner/useCameraScanner.test.ts`, `src/pages/public/RegisterPage.test.tsx` and
`src/lib/securityHeaders.test.ts`.

| ID | Severity | Fix |
| --- | --- | --- |
| R5-01 | Medium | One invite at a time per address. `begin_invite` now also takes a 10-minute lease on the address (longer than an Edge Function request may run) and returns null while another invite holds it; `invite-staff` then answers `409 invite_in_progress` ("being sent right now, try again in a minute"). `set_pending_admin` releases the lease in the same transaction that saves the role, and `invite-staff` calls `end_invite` in a `finally` for every other way a request ends. An older request can therefore no longer reach Auth after a newer one and replace the token of a link already handed out. The 009 generation fence stays as a second line of defence **for the role only** (a request that outlives its lease, or a demotion during an invite, still ends as `stale` and saves nothing); it cannot stop such a request from replacing the Auth token, so the token is protected only while requests cannot outlive the lease (see review 6 below). Test: the real Edge Function is held **before** Auth issues its token (the account row is locked); a second invite is refused within 5 seconds, and the first link is then accepted with the first invite's role. |
| R5-02 | Medium | The scanner tracks a camera stream the moment the camera answers, before the detector is ready, and stops it on any cancellation. Hiding the page cancels a start in progress, not only a running scanner. After every wait (detector and camera, video playback, camera list) a start checks that it is still current before changing anything. A failed start advances the generation, so a camera that answers afterwards is stopped at once. Tests: Stop while the detector loads (stopped without waiting for it), hide during startup, Stop while the camera list loads, unmount before the camera answers; plus guards for overlapping starts and unmounting while the camera list loads. |
| R5-03 | Low | Field and terms errors on the registration page are stored as message keys and translated when shown, like the other errors, so switching language updates them. Test: a validation error and a server `terms_changed`, each followed by a language switch. |
| R5-04 | Low | `src/lib/securityHeaders.test.ts` parses the Vercel and Netlify rules with their paths and checks the headers each route actually receives (guest, staff, scanner, `index.html`, assets). A narrowed rule or a later rule that loosens one route now fails; the test checks that it notices both. Codex's two path mutations fail it. |

Corrections to the review 4 notes, from the same review: the lock order is per path, not one order for every path (it is spelled out in
010's header): `set_pending_admin` takes admin lock → Auth row → generation → profile; `set_user_admin` admin lock → profile → generation;
acceptance Auth row → profile → generation (share); `begin_invite` and `end_invite` only the generation row. (Corrected again in review 6:
see the lock note there.)

Rollout: apply 010, then deploy `invite-staff` right away (it calls `end_invite`, added by 010). 010 keeps every signature that
`invite-staff` v8 uses, so invites keep working in between; but v8 never releases a lease when Auth refuses an invite, so in that gap such
an address would stay reserved for 10 minutes. Then deploy the frontend.

Which new tests reproduce a finding and failed on the previous code: both behavioural R5-01 tests (with the lease removed from
`begin_invite`), four of the R5-02 scanner tests (against the R4 hook), the R5-03 language-switch test, and the R5-04 route tests (with
Codex's path mutations). Guards that already passed before: the R5-01 privilege test, and the overlapping-start and
unmount-during-camera-list scanner tests.

Results after this remediation: unit 94 / 94, integration 127 / 127, E2E 9 / 9.

## Codex review 6 remediation (no migration)

Findings from `docs/CODEX_REVIEW_6.md`. Frontend and test changes only; tests are in `src/scanner/useCameraScanner.test.ts` and
`src/lib/securityHeaders.test.ts`.

| ID | Severity | Fix |
| --- | --- | --- |
| R6-01 | Medium | `switchCamera` records the start generation before it lists the cameras and switches only if it is still current and the page is visible. Stop, hide, unmount and any start (including the one a switch begins) advance the generation, so a switch whose camera list arrives late is dropped instead of restarting the camera. Of two pending switches, the first whose camera list arrives starts the new camera and the other is dropped (corrected in review 7: calling a switch does not by itself advance the generation). Tests (all four fail on the review 5 hook, on their assertions): Switch then Stop, Switch then hide, Switch then unmount, and two overlapping switches (only one new camera is opened). |
| R6-02 | Low | The route-aware header checker lowercases field names (HTTP names are case-insensitive) and collects every value a route receives for each field instead of letting later rules overwrite earlier ones. A security field passes only if every value it gets on that route is the expected one, so a duplicate in any casing fails whatever the host does with repeated fields. Test: lowercase overrides on Vercel's scanner, asset and `index.html` rules and on Netlify's asset rule; it fails with the review 5 checker. |

Documentation corrections from the same review:

- **Lock order.** The sentence "no two paths take a pair in opposite orders" (010's header and the review 5 notes) is wrong:
  `set_pending_admin` takes generation → profile, while acceptance and `set_user_admin` take profile → generation. They cannot deadlock
  because each such pair is already serialized by a lock both take first: `set_pending_admin` and acceptance both start with the
  account's Auth row, and `set_pending_admin` and `set_user_admin` both start with the admin lock. Acceptance and `set_user_admin` take
  profile → generation in the same order. `begin_invite` and `end_invite` take only the generation row. 010's comment is left as applied;
  this note supersedes it.
- **Lease lifetime.** Token safety relies on no request outliving its 10-minute lease. Supabase documents a wall-clock limit of 150 s
  (Free) and 400 s (paid) per Edge Function request, well under it. That does not prove how long an Auth request already sent keeps
  running after a worker is stopped. If the limits change, the function is self-hosted, or invites are retried or queued, revisit this or
  use a coordinator whose exclusion lasts for the whole Auth operation.

Results after this remediation: unit 99 / 99, integration 127 / 127, E2E 9 / 9.

## Codex review 7 remediation (no migration)

Findings from `docs/CODEX_REVIEW_7.md`. Frontend and test changes only; tests are in `src/scanner/useCameraScanner.test.ts`,
`src/pages/scan/ScanPage.camera.test.tsx` (new) and `src/lib/securityHeaders.test.ts`.

| ID | Severity | Fix |
| --- | --- | --- |
| R7-01 | Medium | Each decode loop belongs to the start (generation) that began it. A decode still in progress when that start is stopped, hidden, unmounted or replaced delivers no result and schedules no further decode, so it can neither send an admission after Stop nor attach a second loop to a replacement camera. Tests: a late decode after Stop, hide, unmount and replacement (hook), and the real scanner page with the real hook: Start, Stop, then the decode finishes, and no admission is sent (with a control in which the same decode, without Stop, is admitted). All fail on the review 6 hook except the control. |
| R7-02 | Low | `toggleTorch` changes the torch state only if the same camera is still the active one (same generation and track), on success and on failure. Tests: a torch change finishing after Stop leaves the torch off; a torch failure on a replaced camera does not disable the new camera's torch. Both fail on the review 6 hook. |
| R7-03 | Low | The Netlify side of the header checker reads `netlify.toml` with a TOML parser (`smol-toml`, dev dependency), so quoted keys and single-quoted literal strings are seen like any other field; a value that is neither a string nor a list of strings fails the test. Test: a scoped CSP override written with a quoted key, a literal string, and both with different casing; it fails with the review 6 checker. |

Results after this remediation: unit 108 / 108, integration 127 / 127, E2E 9 / 9.

## Codex review 8 remediation (no migration)

Findings from `docs/CODEX_REVIEW_8.md`: one Low finding; the review confirms R7-01..R7-03 fixed and finds no unfenced asynchronous step
left in the camera hook. Test-only change in `src/lib/securityHeaders.test.ts`.

| ID | Severity | Fix |
| --- | --- | --- |
| R8-01 | Low | A Vercel rule with `has` or `missing` conditions applies only to some requests, so it no longer counts as providing a required security header: every sampled route must get each one from an unconditional rule. A conditional rule's values still count as conflicts, since they apply to some requests. A rule property the checker does not model (Vercel or Netlify) now fails the test instead of being ignored. Test: Codex's `has` and `missing` mutations on the global rule, a conditional rule loosening the policy, and unknown properties on both providers; it fails with the review 7 checker. |

Also in this deploy, outside the reviews: `6e7af0f` adds **Archive event** and **Restore as draft** to the event card menu
(`src/pages/admin/EventsPage.tsx`, tests in `EventsPage.test.tsx` and `tests/integration/archive.test.ts`).

Results after this remediation: unit 113 / 113, integration 129 / 129, E2E 9 / 9.

## Codex review 9 remediation (migration 011)

Findings from `docs/CODEX_REVIEW_9.md` (archive feature and review 8). Database changes are in
`supabase/migrations/20261029000011_review9_remediation.sql`; tests are in `tests/integration/review9-regressions.test.ts`,
`src/lib/api.updateEvent.test.ts`, `src/pages/public/PassPage.test.tsx` (new) and `src/pages/admin/EventsPage.test.tsx`.

| ID | Severity | Fix |
| --- | --- | --- |
| R9-01 | Medium | Every event update states what it expects to overwrite (`updateEvent(id, input, expect)`): the edit form sends the `updated_at` it loaded, and Archive, Restore and Publish send the status they showed. If someone changed the event meanwhile, nothing is updated and the page says it was changed by someone else and asks to reload, so a stale form can no longer silently republish an archived event. Tests: the exact query shape against the database (stale form after archive updates nothing and the event stays hidden; a fresh version applies; a card showing an older status updates nothing), and unit tests that `updateEvent` sends the expectation and reports the conflict. The database tests pass on the old code too (they check the database behaviour the fix relies on); the unit tests cover the fix. |
| R9-02 | Medium | A pass for an archived event is shown as **Not active** with an explanation; its QR is greyed out and the calendar, image and Google Wallet actions are hidden. The pass and its history are kept. `wallet_pass_data` refuses archived events, and the `google-wallet` function answers `409 event_archived`. Scanning was already refused. Tests: `get_pass` reports the archived event, the Wallet lookup and the real Edge Function refuse it and accept it again after Restore, and the pass page shows the archived state (fails on the old page). Wallet objects already saved by guests are not updated remotely. |
| R9-03 | Medium | Shared-network limits raised to Codex's starting values for about 1,000 arrivals in ten minutes behind one address: registrations 600/min and 6,000/h per address, 1,200/min per event, pass and event-page lookups 3,000/min per address. A registration refused by the hourly limit now says so (`window: 'hour'`, message "try again later or use mobile data") instead of "wait a minute". Tests: both windows answer differently (fails on 009's function). |

Also from this review: the Archive confirmation now says what archiving does (registration page closes, existing passes show as not active and cannot be scanned), and Restore says that existing passes can be scanned again right away while the registration page stays closed until the event is published. The archive tests now also check that registrations and scan history survive archive and restore, and that an organizer of a different event is refused.

Results after this remediation: unit 119 / 119, integration 138 / 138, E2E 9 / 9.

## Codex review 10 remediation (no migration)

Findings from `docs/CODEX_REVIEW_10.md`. Frontend only; tests are in `src/pages/admin/EventFormPage.test.tsx` (new) and
`src/lib/api.updateEvent.test.ts`.

| ID | Severity | Fix |
| --- | --- | --- |
| R10-01 | Medium | Editing an existing event now needs its current version. If loading the event fails, the page shows "This event could not be loaded … Nothing has been changed." with **Try again** and **Back**, instead of an editable default form, and submitting is refused while no version is loaded. `updateEvent` takes a required expectation, `{ updatedAt }` or `{ status }` (a type error without one), and also refuses at run time, before any query, when the version and status are both empty, so no application path updates an event by ID alone. Tests: load fails → no form, filling and saving whatever is shown sends nothing (on the old page this saved with `updatedAt: undefined`); retry loads the event and the save carries the loaded `updated_at`; `updateEvent` with `{}`, an empty or a missing version starts no query; `@ts-expect-error` checks that the expectation is required. |

Results after this remediation: unit 122 / 122, integration 138 / 138, E2E 9 / 9.

## Codex review 11 remediation (no migration)

Findings from `docs/CODEX_REVIEW_11.md`. Frontend only; tests are in `src/pages/admin/EventFormPage.test.tsx` and
`src/lib/api.updateEvent.test.ts`.

| ID | Severity | Fix |
| --- | --- | --- |
| R11-01 | Low | The editor is bound to the route's identity: `EventFormPage` renders the editor keyed by the event ID (or `new`), so moving from event A to event B, or from editing to creating, starts a fresh editor with no state from A. As a second guard, the form is shown and saved only when the loaded record's `id` equals the route ID, so an event's record cannot be inferred from a timestamp (A and B in the tests share one `updated_at`). Tests: A loaded → B pending (nothing editable, completing and saving sends nothing) → B fails (error screen, no A values, still nothing sent); A → B loads (B shown, save targets B with B's version); editing A → New (empty form, creates, never updates A). On 350a368 the first sent `updateEvent(B, …, { updatedAt: A's })` and the third kept A's form; the second passes on both (control). In these tests the save step runs before the UI checks, so the old code fails on the save itself. |

Also from this review: `updateEvent` called without any expectation object (plain JavaScript) now fails with the named
`missing_version` error instead of a `TypeError`, still before any query (test covers `undefined` and `null`).

Results after this remediation: unit 125 / 125, integration 138 / 138, E2E 9 / 9.

## Codex review 12 remediation (no migration)

Findings from `docs/CODEX_REVIEW_12.md`. Frontend only; tests are in `src/pages/admin/EventDetailPage.test.tsx` (new) and
`src/pages/admin/EventFormPage.test.tsx`.

| ID | Severity | Fix |
| --- | --- | --- |
| R12-01 | Medium | The event detail screen is bound to the route's event, like the editor and the scanner: `EventDetailPage` renders `<EventDetail key={id}>`, so moving to another event remounts the header, summary, Publish state and every tab with its rows, filters, typed staff email and open dialogs. Responses for the previous event can only reach the discarded instance. Each tab is also keyed by `event.id`. Tests (real page and router, mocked API), using Codex's four schedules: A → B pending (A's Publish is gone; nothing is published); A's Revoke dialog open → B's attendees loaded (no dialog, `revokeRegistration` not called, only B's rows); A's load resolving after B loaded (heading stays B); A's staff → B's staff pending (A's row gone, `removeEventStaff` not called). On 3570022 the first, second and fourth sent the call for A, and the third showed Event A under B's route. |
| R12-02 | Low | New `useIsCurrent()` (`src/lib/useIsCurrent.ts`): after each await, the editor's save and delete and the detail page's Publish check that the screen that started them is still the one shown before navigating or updating state. The operation itself still completes. Tests: A's save finishing after moving to B's editor leaves the router on B's edit URL with B's unsaved change (it used to go to A's detail page); the same for delete (it used to go to `/admin`); A's Publish finishing after moving to B leaves B shown. All three fail on 3570022. |

Also checked: the scanner was already keyed by event (`<Scanner key={eventId}>`); Users has no record route parameter. The Activity and Overview tabs' log and name lookups are reset by the same keys.

Results after this remediation: unit 132 / 132, integration 138 / 138, E2E 9 / 9.

## Codex review 13 remediation (no migration)

Findings from `docs/CODEX_REVIEW_13.md`. Frontend only; tests are in `src/pages/public/RegisterPage.test.tsx` and
`src/pages/admin/event/AttendeesTab.test.tsx` (new).

| ID | Severity | Fix |
| --- | --- | --- |
| R13-01 | Low | The registration form is keyed by the event link (`<RegisterForm key={slug}>`) and uses `useIsCurrent()`. When a registration finishes, the pass is always saved on the device, but the page opens it only if the guest is still on that form; error and busy state of a form the guest has left are not touched. Tests: submit → Back → registration finishes: the guest stays on `/` and the pass is saved; submit → another event's link → finishes: that form stays open and empty, and the first pass is saved. Both redirected to `/pass` on fdbb1bb. |
| R13-02 | Low | The attendee action dialog checks `useIsCurrent()` after its request: the list refresh (`onDone`) still runs, but a dialog dismissed meanwhile no longer calls `onClose` or changes its state, so it cannot close the dialog opened since. Each dialog is also keyed by guest and action. Tests, for revoke, restore and reissue: confirm A → Cancel → open B → A finishes: B's dialog stays open and unconfirmed, nothing is sent for B, and the list refreshes. Revoke and restore fail on fdbb1bb (B's dialog closed); reissue passes on both versions, because reissue never closed the dialog (it is kept as a control). |

Results after this remediation: unit 137 / 137, integration 138 / 138, E2E 9 / 9.

## Codex review 14 remediation (no migration)

Findings from `docs/CODEX_REVIEW_14.md` (Codex pushed it on `codex/passsystem-review-14`; merged into this branch).
Frontend only; tests are in `src/pages/public/RegisterPage.test.tsx`.

| ID | Severity | Fix |
| --- | --- | --- |
| R14-01 | Low | Saved passes are read through a small store, `useStoredPasses()` in `src/lib/passStorage.ts` (`useSyncExternalStore`). `savePass` and `forgetPass` notify it directly, since a write does not fire `storage` in its own document, and the `storage` event covers other tabs. Home and the registration form's "you already have a pass" list therefore show a pass as soon as it is saved, including one from a registration that finished after the guest left, without navigating; the form still lists only its own event's passes. Tests: submit on Gala → Back to Home → registration finishes: Home shows a link to the new pass and the route stays `/`; Gala → Spring → Gala before the response → finishes: Gala's fresh form lists the pass, and Spring's never does; with Spring's form open, a saved Gala pass does not appear but a Spring pass does. All three fail on d87659e. |

Results after this remediation: unit 140 / 140, integration 138 / 138, E2E 9 / 9.

## Owner request: attendee list search and filters (no migration)

Reported by the owner from a phone: left of the "All statuses" menu on the Attendees tab was an unusable sliver. It was
the search field, squeezed to almost no width on narrow screens.

- The search field now has its own full-width row on phones (side by side with the filters from `sm` up), a search icon,
  and a clear (×) button that empties the search at once (no debounce wait).
- **Clear all** appears whenever a search or status filter is active and resets both. On phones it sits on its own line
  under the filters, so the status menu keeps its width.
- An empty result now says "No attendees match these filters." with a **Clear all** button, or "No attendees yet." for an
  event with no registrations.
- Tests: `src/pages/admin/event/AttendeesTab.test.tsx` (search and clear, Clear all resets search and status and returns
  to page 1, both empty states), and an E2E test at phone width (`tests/e2e/workflow.spec.ts`, Pixel 7) that checks the
  search field spans more than 80% of the screen, filters by name, clears, and that Clear all resets an empty filtered
  view.

Results: unit 143 / 143, integration 138 / 138, E2E 10 / 10.

## Codex review 15 remediation (no migration)

Findings from `docs/CODEX_REVIEW_15.md`. Frontend only; tests are in `src/lib/passStorage.test.ts`.

| ID | Severity | Fix |
| --- | --- | --- |
| R15-01 | Low | The saved-pass cache in `useStoredPasses()` is also valid only until the next stored pass reaches its retention deadline (start + 3 days): after that the next read recomputes, so a list opened later no longer shows an expired pass. While a list is shown, a timer notifies it at that deadline (re-arming for waits beyond setTimeout's ~24-day limit), so an open list drops the pass too. The same array is still returned while nothing changed. Tests: Codex's schedule (subscriber at 23:59:59 on day 3, unmount, new subscriber after the deadline sees nothing); an open list drops the expired pass but keeps a later one; snapshot identity across rerenders and a new array after a save. The first two fail on 26b1109. |

Also from this review: stored entries are used only when every field is a string (an object-valued `eventName` or a token-only entry is ignored; test fails on 26b1109), and the pass page's "saved on this device" badge and Forget link follow the store instead of a one-time read.

Results after this remediation: unit 147 / 147, integration 138 / 138, E2E 10 / 10.
