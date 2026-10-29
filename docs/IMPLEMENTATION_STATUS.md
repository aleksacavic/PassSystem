# PassSystem: Implementation Status

Last updated: 2026-10-28 · Branch `claude/passsystem-implementation-h1i74q`

Legend: ✅ done and tested · 🟡 done, needs real-world verification · ⏳ blocked on owner action · ➖ deferred by design

## Overall

| Stage | Status |
| --- | --- |
| A. Repository initialization (Vite, TS, Tailwind, ESLint, Prettier, Vitest, Playwright, CI) | ✅ |
| B. Supabase backend (migrations, RLS, auth integration, RPCs, atomic admission, indexes) | ✅ |
| C. Public pages (registration, confirmation, QR, private pass page) | ✅ |
| D. Administration (login, events, edit, attendees, staff, statistics, users) | ✅ |
| E. Scanning (camera, validation, feedback, repeat-scan protection) | ✅ (🟡 real devices) |
| F. Testing (typecheck, lint, unit, integration, E2E) | ✅ (all passing, see TEST_RESULTS.md) |
| G. Deployment | ✅ Live at https://passsystem-phi.vercel.app (Supabase + Vercel), 2026-10-28 |
| H. Documentation and review package | ✅ README, CODEX_HANDOVER, this file, TEST_RESULTS |
| Independent pre-audit → remediation | ✅ 17 findings; 15 fixed, F-03 partly fixed (CAPTCHA pending), F-16 deferred. See AUDIT_REMEDIATION.md |
| Codex audit → remediation | ⏳ Waiting for the Codex audit report (to run on the remediated head) |

## Definition of done: workflow verification

Each step below was executed automatically by `tests/e2e/workflow.spec.ts` against the local Supabase stack, using
a production build under the production CSP:

| Step | Status |
| --- | --- |
| Organizer signs in, creates and publishes Event A, gets its registration link | ✅ |
| Attendee opens the link on a (emulated) phone, registers with first + last name, receives a unique QR pass | ✅ |
| Operator signs in on another (emulated) phone, selects Event A, scans the pass **with the camera**, gets green + name | ✅ (fake camera stream of the real QR, decoded by zxing-wasm) |
| Scanning the same pass again → already-used rejection | ✅ |
| Event B: separate attendees/records, Event A's pass rejected at Event B | ✅ |
| Administrator inspects registrations and attendance for both events, CSV export | ✅ |
| Writes persist, security controls function (54 integration tests) | ✅ |
| On real phones over a real HTTPS deployment | 🟡 Deployed; owner signed in as administrator. Real-device scan test in progress. |

## Requirement checklist

### Data architecture
- ✅ `events`, `registrations`, `event_staff`, `admission_logs` (+ `profiles` mirror of auth users) with UUIDs,
  FKs, CHECK constraints, unique constraints, indexes, UTC `timestamptz`.
- ✅ Event `timezone` (IANA) added so attendees see local event times.
- ✅ Archive without deleting. Events with registrations cannot be deleted (`ON DELETE RESTRICT`).
- ✅ No global uniqueness on name or email. Per-event passes.
- ✅ Tokens: 120-bit CSPRNG, stored only as SHA-256. Logs never contain raw tokens (tested).
- ✅ RLS on every public table, column-level grants hide hashes, `anon` has no table access at all.

### Event management
- ✅ Event list with date, status, registered, admitted, remaining, and quick Manage/Copy link/Scan actions.
- ✅ Create/edit form: name, link slug, description, location, time zone, start/end, registration open/close,
  capacity, status.
- ✅ Public link and registration QR: Copy link, Download QR poster, QR-only PNG.
- ✅ Attendees: name, email, registration date, status, check-in time. Search, status filter, pagination, CSV
  export (formula-injection safe).
- ✅ Revoke / restore / reissue (reissue rotates the credential; the old QR stops working).
- ✅ Stats: registrations, checked in, not yet checked in, admission %, progress bar. Auto-refresh every 10 s.
- ✅ Activity tab: last 100 scan attempts.

### Public registration
- ✅ Mobile-first page: title, date (in event time zone), location, instruction, form.
- ✅ Client and server validation (mirrored rules).
- ✅ Confirmation: name, event, large QR, status, Save QR (share sheet / download), Copy pass link, entrance
  instruction.
- ✅ Private pass URL `/pass#TOKEN` (fragment, never sent to servers). Shows "used" or "revoked" after the fact.
- ✅ localStorage list of passes on this device (secondary only).
- ✅ Double-tap protection (in-flight guard + server idempotency key), honeypot, rate limits.
- ✅ English and Arabic (right-to-left) guest pages with a language switch; Add to calendar (`.ics`).
- ➖ Emailing passes (deferred enhancement).

### Scanner
- ✅ Large live preview, start/stop, permission handling, rear camera preference, target overlay, torch when
  available, camera switching, manual entry, rapid repeat scanning, persistent event context.
- ✅ Server validation with authorization, event match, revocation, one-time atomic admission, logging.
- ✅ Green / red (already used with original time, wrong event, invalid, revoked) / amber (network or server;
  never green).
- ✅ Repeat-detection suppression (tested: one request in 5 s with the QR held in view).
- ✅ Wake lock, sound and vibration feedback, camera released when backgrounded.
- 🟡 Real-device verification on iOS Safari and Android Chrome.
- ➖ Offline admission (excluded by requirement).

### Authentication and staff
- ✅ Supabase Auth login, session persistence and refresh, logout (local scope), protected routes.
- ✅ Organizer/operator per-event roles, system administrators.
- ✅ Public sign-up disabled. Bootstrap via script or `private.bootstrap_admin()`.
- ✅ Organizers assign existing users as operators by email. Admins assign organizers and grant admin rights.
- ✅ Invite and password-reset flows land on a "choose your password" page (E2E tested with an invite link).
- ➖ In-app user creation (would need an Edge Function with the secret key). Use the dashboard or the script.

### Quality and security
- ✅ All functional, concurrency and security tests listed in the brief (see TEST_RESULTS.md mapping).
- ✅ CSP and security headers, bundle secret scan, no `dangerouslySetInnerHTML`, open-redirect guard.
- 🟡 IP-based rate limiting depends on deployment proxy headers. There is an admin diagnostic on the Staff page.

## Defects found and fixed during self-review

| # | Severity | Issue | Fix |
| --- | --- | --- | --- |
| 1 | High | `add_event_staff` upsert let an organizer downgrade another organizer to operator | Non-admins cannot change an existing organizer's role; regression test added |
| 2 | Medium | `signOut()` default scope was global, so signing out one door phone would sign out the same account everywhere | `signOut({ scope: 'local' })` |
| 3 | Medium | Invite links land on `/`, where the set-password redirect did not trigger | Root route redirects invite/recovery sessions to `/account`; E2E test added |
| 4 | Medium | Rate-limit IP source used the client-controllable left-most `X-Forwarded-For` | Order is now `cf-connecting-ip` (configurable trust) → `x-real-ip` → right-most XFF; spoofing test added |
| 5 | Config | `[auth.email] enable_signup=false` in the CLI config disables email login entirely | Documented; only the global `[auth] enable_signup=false` is used |

## Deployment (production)

| Item | Value |
| --- | --- |
| Site | https://passsystem-phi.vercel.app (Vercel project `passsystem`, linked to this GitHub repo) |
| Supabase project | `wvwpedmwhsddsfixjpjd` (region ap-southeast-2, Postgres 17.11) |
| Migrations | 10/10 applied through the Management API and recorded in `supabase_migrations.schema_migrations` (004 = audit remediation, 005 = wallet lookup, 006 = attendance terms + phone, 007 = Codex review 2 remediation, 008 = Codex review 3 remediation, all applied 2026-10-28; 009 = Codex review 4 remediation and 010 = Codex review 5 remediation, applied 2026-10-29). `invite-staff` redeployed after 010 (version 9, 2026-10-29 06:20 UTC). |
| Frontend | Production deployment of commit `ae85b86` (Codex review 5 remediation; includes the Sand & Teal redesign and Arabic guest pages), https://passsystem-phi.vercel.app |
| Rate-limit IP source | `trust_cf_connecting_ip = 1` (Supabase Cloud). The deployment check line reports `cf-connecting-ip`. The in-browser **Test header spoofing** button cannot run against Supabase Cloud (the request carrying the probe header is rejected before it reaches the database), so forgeability is unconfirmed. A server-side probe (pg_net request through the public URL) is pending owner approval. |
| Edge Functions | `invite-staff`, `remove-staff` (verify_jwt on) and `google-wallet` (verify_jwt off) deployed 2026-10-28, ACTIVE (`invite-staff` and `remove-staff` at `8399992`: invite links, `mark_pending_admin`, admin delete guard). `remove-staff` deletes a non-admin account (or cancels a pending invite); assignments cascade, check-in history is kept. Google Wallet: issuer ID and service-account key secrets set, `VITE_GOOGLE_WALLET=1` set in Vercel (production + preview), 2026-10-28. Issuer is in demo mode: only Wallet Console test accounts can save passes until Google grants publishing access. |
| Live schema checks | RLS on all 5 tables; anon can execute only `get_pass`, `get_public_event`, `register_for_event`; every SECURITY DEFINER function pins `search_path`; credential hashes not selectable |
| Auth | Public sign-up **off**, email login on, minimum password length 10, Site URL and redirect allow list set to the Vercel domain |
| Vercel protection | Standard: production domain public, preview deployments require Vercel login |
| Administrator | Bootstrapped with `private.bootstrap_admin()` (owner's account) |
| Frontend env | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (production, preview, development) |

Deployment notes:
- Merging to `main` deploys production automatically. The first production build was made from the PR branch
  through the Vercel API.
- Still to verify on the live stack: a real-device camera scan, and the header-spoofing probe above.
- Have the default attendance terms (`private.default_terms_text()`, migration 006) reviewed by a UAE lawyer.
- Optional: set the Supabase password requirement to "letters and digits" so it matches the app's own check.
- Remove the deployment tokens (Supabase access token, Vercel token) when they are no longer needed.

## Pull request

- PR: https://github.com/aleksacavic/PassSystem/pull/1 (draft, `claude/passsystem-implementation-h1i74q` → `main`)
