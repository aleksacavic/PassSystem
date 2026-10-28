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
