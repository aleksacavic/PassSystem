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
| G. Deployment | ⏳ Needs a Supabase project and hosting authorization from the owner |
| H. Documentation and review package | ✅ README, CODEX_HANDOVER, this file, TEST_RESULTS |
| Codex audit → remediation | ⏳ Waiting for the Codex audit report |

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
| On real phones over a real HTTPS deployment | ⏳ Needs deployment |

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

## Blocked on the owner (deployment)

To deploy, I need the following. Use secure channels: environment secrets or connectors, not chat, for anything
secret.

1. **Supabase project**: either
   - give the session a Supabase access token as an environment secret (`SUPABASE_ACCESS_TOKEN`) plus the project
     ref and DB password as secrets, and I will run `supabase link` + `supabase db push`, **or**
   - run `npx supabase link --project-ref <ref> && npx supabase db push` yourself, then send me only the project
     URL and publishable key (both are public values).
   - In the dashboard: Authentication → Sign In / Providers → **Allow new users to sign up: OFF**, and set Site URL
     and Redirect URLs to the deployed origin (and `/account`).
2. **Hosting**: connect the GitHub repository to Vercel (or Netlify), and set `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY`. Alternatively, provide a `VERCEL_TOKEN` as an environment secret and I can
   deploy with the Vercel CLI.
3. **First administrator**: run `npm run staff:create -- --email <you> --admin` locally with the secret key, or
   create the user in the dashboard and run `select private.bootstrap_admin('<you>')`.

## Pull request

- PR: opened from `claude/passsystem-implementation-h1i74q` into `main` (number recorded below once created).
