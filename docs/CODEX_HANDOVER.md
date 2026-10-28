# PassSystem: Technical Handover for Independent Review (Codex)

Prepared by Claude after implementation and self-testing. Read this together with
[`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) and [`TEST_RESULTS.md`](TEST_RESULTS.md).

---

## Review instructions for Codex

> Perform an independent, critical technical audit of PassSystem. Verify architecture, code quality, event
> isolation, Supabase RLS policies, credential security, authentication, transaction safety, concurrency, public
> registration abuse controls, mobile camera compatibility, and test coverage.
>
> Do not assume Claude's implementation is correct. Reproduce key workflows and identify defects,
> vulnerabilities, or incomplete functionality. Run applicable tests and add missing tests where necessary.
>
> Prioritize findings as Critical, High, Medium, or Low. For every material finding, identify affected files,
> explain the problem, and recommend a concrete fix. Clearly distinguish verified defects from risks or
> recommendations.
>
> Produce a written audit report suitable for Claude to use for remediation.

Suggested report location: `docs/CODEX_AUDIT.md`. For each finding, give the severity, title, status (verified
defect / risk / recommendation), affected files and lines, a reproduction (test, curl or steps), and a
recommended fix.

---

## 1. System objective and requirements summary

A lightweight, multi-event registration and entrance system:

- An organizer creates events, each with a public registration URL `/e/<slug>` and a registration QR.
- An attendee registers with first and last name (required) and an optional email. No account is needed. They
  immediately receive a unique QR pass and a private pass link.
- An authorized door operator scans the pass with a phone camera. The **server** validates it, shows
  green/red/amber, the attendee's name and the reason, and records the admission.
- **One successful admission per pass, scoped to its event.** The same person can attend other events with
  separate passes.
- Admins and organizers see registrations, admissions and statistics, and can export CSV, revoke, restore and
  reissue passes.
- Event data is isolated per event. Staff permissions are verified server-side.

The original brief: Mission, Product concept, Data architecture, Event management, Public registration, Scanner,
Auth, Design, Quality/Security, Execution process, Codex handover, Definition of done. It is summarized in
`IMPLEMENTATION_STATUS.md` with a requirement-by-requirement status.

## 2. Implemented architecture and technology decisions

| Layer | Choice | Rationale |
| --- | --- | --- |
| Frontend | React 19, TypeScript 6, Vite 8, Tailwind CSS 4, react-router 7 | Static SPA, deployable to any HTTPS static host |
| Backend | Supabase Postgres + PostgREST + Supabase Auth | No custom server. Atomic logic in SQL. |
| Privileged ops | `SECURITY DEFINER` plpgsql functions, `search_path = ''`, explicit `auth.uid()` checks | Transactional, testable, no secrets in browser |
| QR generation | `qrcode` (client-side, PNG data URLs) | Small, offline-capable rendering |
| QR scanning | Native `BarcodeDetector` → fallback `barcode-detector` ponyfill (`zxing-wasm`, **self-hosted .wasm**) | Maintained; works on iOS Safari; no CDN dependency (CSP) |
| Tests | Vitest (unit, jsdom), Vitest (integration against local Supabase), Playwright 1.63 (E2E) | |
| Hosting | `vercel.json` / `netlify.toml` with SPA rewrites + CSP | Not yet deployed (needs owner authorization) |

Deliberate non-choices: no Edge Functions, no Node server, no Docker infra for production, no Realtime, no offline
mode.

## 3. Repository structure

```
src/
  App.tsx                     routes; Root redirects invite/recovery sessions to /account
  main.tsx, index.css         entry + design tokens (Tailwind @theme)
  auth/AuthProvider.tsx       session, profile, needsPassword; signOut(scope: local)
  auth/RequireAuth.tsx        protected routes (+ admin-only)
  lib/api.ts                  ALL Supabase calls (RPC + table reads), typed
  lib/passToken.ts            normalize/format/extract tokens; pass & registration URLs
  lib/errors.ts               error-code → message mapping (codes travel in PostgREST `hint`)
  lib/datetime.ts             IANA time-zone conversion for datetime-local inputs
  lib/csv.ts                  CSV with formula-injection protection
  lib/validation.ts           client validation mirroring SQL rules
  lib/passStorage.ts          localStorage convenience list of passes (secondary only)
  pages/public/*              Home, Register (/e/:slug), Pass (/pass#token), NotFound
  pages/admin/*               Login, Account, Events, EventForm, EventDetail(+event/*Tab), Users
  pages/scan/ScanPage.tsx     event picker + scanner UI + result states
  scanner/useCameraScanner.ts getUserMedia, decode loop, torch, camera switch, visibility handling
  scanner/detector.ts         native vs wasm detector, self-hosted wasm URL
  scanner/scanGate.ts         in-flight + same-code suppression (unit tested)
supabase/migrations/
  20261028000001_core_schema.sql      tables, enums, constraints, indexes, triggers, private settings
  20261028000002_access_control.sql   helpers, privileges (REVOKE + column GRANTs), RLS policies
  20261028000003_functions.sql        all RPCs + function privileges
supabase/config.toml          local stack (enable_signup = false)
scripts/create-staff-user.mjs admin API script (secret key, trusted machine only)
scripts/dev-seed.mjs          local demo accounts (refuses non-local URLs)
scripts/check-bundle-secrets.mjs  scans dist/ for privileged keys/JWTs
security-headers.mjs          CSP etc. (used by vite preview; mirrored in vercel.json / netlify.toml)
tests/integration/*.test.ts   registration, admission, concurrency, security
tests/e2e/workflow.spec.ts    full workflow incl. camera via fake video (tests/e2e/fakeCamera.ts)
.github/workflows/ci.yml      checks + integration + E2E
```

## 4. Database schema and migration files

Migrations (apply in order): `supabase/migrations/20261028000001_core_schema.sql`, `…0002_access_control.sql`,
`…0003_functions.sql`.

**Public tables** (all with RLS enabled):

- `profiles(id → auth.users, email, display_name, is_admin, created_at)`. Mirrors `auth.users` through the
  `on_auth_user_created` / `on_auth_user_email_changed` triggers.
- `events(id, name, slug unique, description, location, timezone, starts_at, ends_at, registration_opens_at,
  registration_closes_at, status enum, max_attendees, created_at, updated_at, created_by)`. CHECK constraints
  cover lengths, the slug format, `ends ≥ starts` and the registration window. A trigger validates the IANA time
  zone, trims fields and freezes `created_by`/`created_at` on update. A second trigger adds the creator as
  organizer.
- `registrations(id, event_id → events ON DELETE RESTRICT, first_name, last_name, email?, pass_token_hash bytea(32)
  UNIQUE, request_id_hash bytea(32)?, status enum, registered_at, checked_in_at, checked_in_by, revoked_at,
  revoked_by, token_issued_at, token_version)`. The `registrations_checkin_consistency` CHECK ties `status` to its
  timestamps. Unique `(event_id, request_id_hash)`. Indexes on `(event_id, status)`,
  `(event_id, registered_at desc)` and the name columns.
- `event_staff(id, event_id, user_id → profiles, role enum organizer|operator, created_at, created_by)`, unique
  `(event_id, user_id)`.
- `admission_logs(id, registration_id?, event_id, operator_id, attempted_at, result enum, details jsonb)`, indexed by
  event/time and by registration.

**Private schema** (`private`, not exposed by PostgREST; no grants except the 4 helper functions):
`settings` (tunable limits), `app_secrets` (`ip_hash_salt`), `rate_limit_buckets`, the token generator,
normalization, hashing and authorization helpers, and `bootstrap_admin`.

## 5. Authentication and authorization design

- Supabase Auth with email and password. **Public sign-up disabled** (`[auth] enable_signup = false`). In the
  CLI, `[auth.email] enable_signup` must stay `true` because it toggles the email provider itself, which we found
  during testing. On hosted projects: *Allow new users to sign up = OFF*.
- First admin: `npm run staff:create -- --email … --admin` (secret key) or `select private.bootstrap_admin('…')`
  run as the database owner.
- Roles: `profiles.is_admin` for system admins. `event_staff.role` is per event: `organizer` (manage the event,
  attendees, operators, logs) or `operator` (scan only).
- Helpers: `private.is_admin()`, `private.has_event_role()`, `private.is_event_organizer()` and
  `private.is_event_staff()`. All are `SECURITY DEFINER` (avoids RLS recursion) and `STABLE`.
- **Privileges:** everything is revoked from `anon`/`authenticated` on public tables, then re-granted
  minimally:
  - `authenticated` can `SELECT` profiles, events, event_staff and admission_logs.
  - `registrations` `SELECT` is **column-limited**: `pass_token_hash` and `request_id_hash` are not selectable by
    anyone through the API.
  - `INSERT`/`UPDATE` on `events` is limited to editable columns, so `created_by` and timestamps cannot be forged.
  - There are no direct writes to registrations, event_staff, admission_logs or profiles.
- **RLS policies** (`…0002_access_control.sql`):
  - profiles: self, or admin.
  - events: select by event staff; insert by admin, with `created_by = auth.uid()`; update by organizer; delete by
    admin.
  - registrations and admission_logs: select by organizers (and admins).
  - event_staff: self, or organizer.
- **Function EXECUTE:** revoked from PUBLIC. `anon` may execute only `get_public_event`, `register_for_event` and
  `get_pass`; an integration test asserts this from the catalog. Staff RPCs are granted to `authenticated` and
  check authorization internally.
- Frontend: `RequireAuth` guards `/admin*`, `/scan*`, `/account`. Admin-only: `/admin/users`. The `?next=`
  redirect is restricted to same-app paths (`lib/nav.ts`). Sign-out uses `scope: 'local'`.
- Invite and recovery links set `needsPassword`, and the root route sends the user to `/account` to choose a
  password.

## 6. Public registration flow

`RegisterPage` → `register_for_event(p_slug, p_first_name, p_last_name, p_email, p_request_id, p_website)`:

1. Per-IP rate limits: 30/min and 400/h by default, keyed on a salted SHA-256 of the client IP.
2. Honeypot (`p_website`).
3. Server validation. Names are whitespace-collapsed and must be 1–100 characters with no control characters and
   no `<` or `>`. The email is lowercased and checked against an RFC-ish regex, up to 254 characters.
4. `SELECT … FOR UPDATE` on the event row, which serializes capacity checks. Draft and archived events → not
   found.
5. Per-event flood limit (600/min).
6. **Idempotency:** if `(event_id, sha256(request_id))` exists within 30 minutes and is still `registered`, the
   token is rotated and the same registration is returned (`replayed: true`). The browser keeps one `request_id`
   per attempt and reuses it on retry. Only the original browser knows it.
7. Window and status checks (`private.registration_state`), then capacity (non-revoked count).
8. Insert with `sha256(token)`. The raw token is returned once.

Expected failures are returned as `{ok:false, error}` rather than raised, so rate-limit counters commit.

The pass page (`/pass#TOKEN`) calls `get_pass(token)`, which is rate limited at 120/min per IP. It returns names,
status, check-in time and public event fields only, never the email or ids. The page re-checks status on
`visibilitychange`.

## 7. QR credential generation and verification

- `private.generate_pass_token()`: 15 bytes from `extensions.gen_random_bytes` → 24 Crockford-base32 characters
  (120 bits). The test suite checks 5,000 tokens for uniqueness and a uniform character distribution.
- `private.normalize_pass_token()` (SQL) and `normalizePassToken()` (TS) apply the same rules: uppercase, strip
  spaces and dashes, map `O→0` and `I/L→1`, and require `^[0-9A-HJKMNP-TV-Z]{24}$`.
- Storage: `sha256(normalized)` in `registrations.pass_token_hash` (unique). It is unkeyed, which is acceptable
  for 120-bit random secrets (reviewer: confirm you agree).
- QR content: `${VITE_PUBLIC_SITE_URL or origin}/pass#TOKEN`. The scanner's `extractPassToken()` accepts that
  format, legacy `/p/TOKEN` and `?t=TOKEN`, or a bare or grouped code for manual entry. Anything else is shown as
  "NOT A VALID PASS" locally. That is never a success, and nothing is sent to the server.
- Reissue (`reissue_pass`, organizer) replaces the hash. The old QR becomes invalid immediately, and the new token
  is shown to the organizer once.

## 8. Atomic single-admission implementation

`public.admit_pass(p_event_id, p_token)` in `…0003_functions.sql`:

1. Requires `auth.uid()`; the caller must be staff (or admin) for `p_event_id`, otherwise `42501`. An archived
   event → error `event_archived`.
2. Normalizes the token and runs `SELECT * FROM registrations WHERE pass_token_hash = sha256(token) FOR UPDATE`.
3. Decision order: invalid → `wrong_event` (identity revealed only if the caller is also staff of the pass's
   event) → `revoked` → `already_used` (returns the original `checked_in_at`) → admit (`UPDATE … SET
   status='checked_in' … WHERE status='registered'`).
4. Inserts into `admission_logs` (result, operator, details without the raw token) in the same transaction.

Under READ COMMITTED, a concurrent second scan blocks on the row lock and then re-reads the committed
`checked_in` row. Tests cover this in three ways: 10 two-operator races, a 20-request burst, and a deterministic
two-connection interleaving that holds the first transaction open (`tests/integration/concurrency.test.ts`).

## 9. Scanner behavior

`src/pages/scan/ScanPage.tsx`, `src/scanner/*`:

- Event picker shows only events the user is staff for. A persistent header shows the event name and live
  admitted/remaining counts.
- Camera: `getUserMedia({ facingMode: { ideal: 'environment' }, 1280×720 })`. Decode loop every 120 ms, one
  detection at a time. Torch toggle if `getCapabilities().torch`. "Switch camera" if there is more than one camera.
  The camera is released while the page is hidden and resumed when it is visible again. A screen wake lock is held
  while scanning. Errors are classified: permission denied, no camera, camera busy, insecure context, unsupported.
- `ScanGate`: one request in flight. The same credential is ignored while it stays in view; each sighting extends
  a 3 s quiet period. A different credential is accepted immediately. Manual entry and Retry bypass the cooldown.
- Results:
  - Green ADMITTED, shown for 2.5 s: name, event and time.
  - Red, shown for 5 s: ALREADY USED (with the original time), REVOKED, WRONG EVENT, INVALID PASS, NOT ALLOWED.
  - **Amber NOT VERIFIED — TRY AGAIN**: on network, server or 10 s timeout errors. Stays until Retry or dismiss.
    Reads "Do not admit".
  - Sound (WebAudio, unlocked on the Start tap) and vibration.
  - Session history of the last 12 scans.
- Manual entry accepts a code or URL.

## 10. Environment variables and deployment configuration

- Browser (build time): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (or legacy
  `VITE_SUPABASE_ANON_KEY`), optional `VITE_PUBLIC_SITE_URL`. See `.env.example`.
- Operator machine only: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` for `scripts/create-staff-user.mjs`.
- Tunables in `private.settings`: rate limits, replay window, `trust_cf_connecting_ip`.
- Headers: `security-headers.mjs`, `vercel.json`, `netlify.toml`.
  - CSP `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval'`; `connect-src` limited to Supabase;
    `frame-ancestors 'none'`.
  - `Referrer-Policy: no-referrer`; `Permissions-Policy: camera=(self)`.
  - The E2E suite runs under this CSP and asserts that there are no CSP violations.
- **Deployment status:** not deployed. The Supabase project and Vercel/Netlify project need owner action (see
  `IMPLEMENTATION_STATUS.md`).

## 11. Test coverage and results

See [`TEST_RESULTS.md`](TEST_RESULTS.md). Summary: 35 unit/component, 54 integration (real local Supabase), and 5
Playwright E2E tests, plus typecheck, lint, build and the bundle-secret scan. All pass.

## 12. Known issues and deferred enhancements

See README "Known limitations" and `IMPLEMENTATION_STATUS.md`. The most important:

- IP-based rate limiting depends on proxy headers. The recommended next step is a CAPTCHA (Turnstile).
- No emailing of passes, no Realtime (polling instead), no check-in undo, no in-app user creation.
- Real-device camera testing on iOS Safari and Android Chrome is still pending.

## 13. Security-sensitive files and operations

| File / object | Why it matters |
| --- | --- |
| `supabase/migrations/20261028000002_access_control.sql` | All table privileges and RLS policies |
| `supabase/migrations/20261028000003_functions.sql` | `register_for_event`, `get_pass`, `admit_pass`, `reissue_pass`, `revoke/restore`, `add/remove_event_staff`, `set_user_admin`, `diagnose_client_ip`, `private.client_ip_info`, `private.bootstrap_admin`; function GRANTs |
| `supabase/migrations/20261028000001_core_schema.sql` | Constraints, auth.users trigger (`SECURITY DEFINER`), creator→organizer trigger, salt generation |
| `supabase/config.toml` | Sign-up disabled, password policy (local) |
| `src/lib/supabase.ts`, `src/lib/env.ts` | Only public config in the browser |
| `src/lib/passToken.ts`, `src/lib/api.ts#admitPass` | Credential parsing; amber-on-failure guarantee |
| `src/auth/*`, `src/lib/nav.ts` | Route protection, redirect safety, invite/recovery handling |
| `scripts/create-staff-user.mjs` | Uses the secret key (run locally only) |
| `scripts/check-bundle-secrets.mjs`, `security-headers.mjs`, `vercel.json`, `netlify.toml` | Secret leakage and browser hardening |

## 14. Instructions for independently validating the implementation

```bash
git checkout claude/passsystem-implementation-h1i74q
npm ci
npm run db:start          # Docker required. If ECR pulls fail: SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io npm run db:start
npm run typecheck && npm run lint && npm test
npm run test:integration
npx playwright install chromium   # if no browser is available
npm run test:e2e
npm run build && npm run check:bundle-secrets
```

Manual workflow (definition of done):

1. `npm run db:seed:dev && npm run dev`. Sign in at `http://localhost:5173/login` as `admin@passsystem.test` /
   `AdminPass123`.
2. Create Event A → Publish → copy the link. Open it in a phone-sized window (or a phone on the same LAN via
   `npx vite --host`; the camera then needs HTTPS, e.g. a tunnel) and register with a name.
3. Assign `operator@passsystem.test` to Event A (Staff tab). In another browser, sign in as the operator → Scan →
   Event A → scan the pass (or enter the code) → green. Scan again → red ALREADY USED.
4. Create Event B and scan Event A's pass there → WRONG EVENT. Check the Attendees and Activity tabs and the CSV.

Suggested adversarial checks (not exhaustive):

- Try every table and RPC with the anon key and with an unassigned staff JWT (curl examples in
  `tests/integration/security.test.ts`).
- Try `select pass_token_hash` through PostgREST, embedded resources (`registrations?select=*,events(*)`), and
  `count=exact` side channels.
- Look for a `SECURITY DEFINER` function that can be abused: argument injection, missing authorization, or an
  information leak through error messages or the `wrong_event` path.
- Race `register_for_event` against `max_attendees`. Race `reissue_pass` against `admit_pass`.
- Check whether `x-forwarded-for` or `cf-connecting-ip` spoofing bypasses rate limits in your deployment model.
- Review the replay or idempotency logic in `register_for_event` for token-leak or pass-hijack paths.
- Review the CSP, the open-redirect guard, and XSS sinks (no `dangerouslySetInnerHTML` is used).
- Run the scanner on real iOS Safari 16+ and Android Chrome over HTTPS: permission prompt, rear camera, torch, and
  resuming after app switching.

**Real-device checklist (not yet executed):** iPhone Safari camera start, decode speed under dim light, torch
(not available on iOS), backgrounding and resuming, Save QR (share sheet), Android Chrome native
BarcodeDetector path, Firefox Android wasm path.

## 15. Commit hash and pull request reference

- Branch: `claude/passsystem-implementation-h1i74q`
- Implementation commits: `5fe0611` (application), `e21c129` (tests, CI, headers), `91fc6e4` (self-review
  fixes). The documentation commit follows; see `git log`.
- Pull request: https://github.com/aleksacavic/PassSystem/pull/1 (draft). Numbers are also recorded in
  `IMPLEMENTATION_STATUS.md` after creation).
