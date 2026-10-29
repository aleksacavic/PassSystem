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
`src/pages/public/RegisterPage.test.tsx`, `src/lib/calendar.test.ts` and `src/lib/securityHeaders.test.ts`. Each test was run against the
previous code (or that code's behaviour restored in the local database) and failed there.

| ID | Severity | Fix |
| --- | --- | --- |
| R4-01 | Medium | Every invite reserves a generation for its email address (`begin_invite`) **before** Supabase Auth issues the link. `set_pending_admin(user, admin, generation, invited_by)` applies the role only while that generation is current; otherwise it returns `stale` and changes nothing, and `invite-staff` answers `409 invite_superseded` without a link. A queued promotion records its generation, and the acceptance trigger honours it only if it is still current. Demotion (`set_user_admin`) advances the generation, which voids every invite request still in flight. One lock order everywhere: admin lock → Auth user row → generation row → profile. Tests: both of Codex's interleavings, an invite's own late save after acceptance and demotion, a queued promotion overtaken by a newer accepted invite, and the real Edge Function held at the role step while a newer invite is reserved. |
| R4-02 | Medium | The camera request is kept on its own. Whatever happens to a start (detector failure before or after the camera answers, a newer start, a stop), a stream it obtains is stopped unless it became the active one. Unmounting also advances the start generation. Tests cover both failure orders and unmounting mid-start. |
| R4-03 | Medium | `validate_event` still refuses to change an event's creator, but now allows clearing it, so `ON DELETE SET NULL` works when the creator's account is deleted. The test deletes a demoted creator who also assigned staff and scanned a guest, and checks every column that references Auth users. |
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
