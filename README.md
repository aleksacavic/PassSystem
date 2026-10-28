# PassSystem

Mobile-first, multi-event registration and QR access control.

An organizer creates an event and shares its registration link or QR code. Attendees register with their
name (email optional) and immediately get a personal QR pass, with no account or app needed. Door operators
sign in on a phone, scan the pass with the camera, and get a server-verified **green / red / amber** result.
Each pass admits **one entry to its own event**.

- **Stack:** React 19 + TypeScript + Vite + Tailwind CSS 4 (static SPA) · Supabase (Postgres, Auth, PostgREST)
- **No custom server:** all privileged logic lives in Postgres `SECURITY DEFINER` functions guarded by RLS.
- **Live:** https://passsystem-phi.vercel.app
- **Status:** implemented, tested against a full local Supabase stack, and deployed. See
  [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) and [`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md).
  Reviewers: start with [`docs/CODEX_HANDOVER.md`](docs/CODEX_HANDOVER.md).

---

## Architecture

```
 Attendee phone             Operator phone / Organizer laptop
 ───────────────            ─────────────────────────────────
 /e/:slug  register         /login   Supabase Auth (email + password)
 /pass#TOKEN  QR pass       /admin   events, attendees, staff, activity
        │                   /scan/:eventId   camera scanner
        │  anon key                 │  user JWT
        ▼                           ▼
 ┌──────────────────── Supabase ─────────────────────────────┐
 │ PostgREST  →  public RPCs (SECURITY DEFINER, search_path='')│
 │   anon:  get_public_event · register_for_event · get_pass   │
 │   staff: admit_pass · revoke/restore/reissue · staff mgmt   │
 │ Tables (RLS on, column grants): events, registrations,      │
 │   event_staff, admission_logs, profiles                     │
 │ private schema (not exposed): rate limits, settings, salt,  │
 │   token generator, authorization helpers                    │
 └─────────────────────────────────────────────────────────────┘
```

Key decisions:

| Area | Decision |
| --- | --- |
| Pass credential | 120-bit random token (24 Crockford base32 characters) generated in Postgres with `gen_random_bytes`. Only `sha256(token)` is stored. The QR encodes `https://<site>/pass#TOKEN`. The token sits in the URL **fragment**, so it never reaches web-server logs or `Referer` headers. |
| Single admission | `admit_pass` locks the registration row (`SELECT … FOR UPDATE`) and updates it in the same transaction. Concurrent scans serialize, so exactly one returns `admitted`. Every attempt is written to `admission_logs`. |
| Event isolation | Each registration belongs to one event. `admit_pass` takes the scanner's event id and returns `wrong_event` for passes from other events. |
| Authorization | System admins (`profiles.is_admin`). Per-event roles in `event_staff`: **organizer** (manage the event, attendees and operators) and **operator** (scan only). Checks run server-side against `auth.uid()`. |
| Public abuse controls | Per-IP (salted hash) and per-event rate limits, a honeypot field, server-side validation, capacity limits, and an idempotency key against double taps and retries. Public staff sign-up is disabled. |
| Scanner | Native `BarcodeDetector` where it supports QR, otherwise the self-hosted `zxing-wasm` ponyfill (iOS Safari, Firefox). Rear camera, torch, camera switching, wake lock, manual code entry. Repeat-scan suppression: one request in flight, and the same QR is ignored while it stays in view. |
| Network | Online validation only. A failure shows **amber "NOT VERIFIED — TRY AGAIN"** and never green. |

Repository layout:

```
src/
  pages/public/      HomePage, RegisterPage (/e/:slug), PassPage (/pass#token)
  pages/admin/       Login, Account, Events, EventForm, EventDetail (+ event/ tabs), Users
  pages/scan/        ScanPage (event picker + scanner)
  scanner/           camera hook, QR detector, scan gate (dedupe), feedback, wake lock
  lib/               api.ts (all Supabase calls), passToken, datetime, csv, validation, …
  auth/              AuthProvider, RequireAuth
  components/        design system (ui/), layouts, QR image, modal
supabase/
  config.toml        local stack config (sign-up disabled)
  migrations/        001 core schema · 002 access control/RLS · 003 functions
scripts/             create-staff-user.mjs, dev-seed.mjs, check-bundle-secrets.mjs
tests/integration/   Vitest against the local Supabase stack (REST + Postgres)
tests/e2e/           Playwright, including a fake camera stream of the real pass QR
docs/                Codex handover, implementation status, test results
```

---

## Local development

Requirements: Node 20.19+ (22 recommended) and Docker (for the local Supabase stack).

```bash
npm install
npm run db:start            # local Supabase: Postgres, Auth, REST, gateway (applies migrations)
npm run db:status           # prints API_URL, PUBLISHABLE_KEY, …
cp .env.example .env.local  # set VITE_SUPABASE_URL=http://127.0.0.1:54321 and the publishable key
npm run db:seed:dev         # demo accounts (local only)
npm run dev                 # http://localhost:5173
```

Demo accounts created by `db:seed:dev` (local stack only):

| Email | Password | Role |
| --- | --- | --- |
| admin@passsystem.test | AdminPass123 | administrator |
| organizer@passsystem.test | OrganizerPass123 | staff (assign to an event as organizer) |
| operator@passsystem.test | OperatorPass123 | staff (assign to an event as operator) |

> If Docker Hub works but `public.ecr.aws` does not, start with
> `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io npm run db:start`.

`npm run db:reset` re-applies all migrations to a fresh local database. Run `db:seed:dev` again afterwards.

---

## Environment variables

Only `VITE_*` variables reach the browser bundle. **Never** put the secret or service-role key in a `VITE_*`
variable. `npm run check:bundle-secrets` fails the build check if a privileged key appears in `dist/`.

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | hosting (build time) | Supabase project URL, e.g. `https://abcd.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | hosting (build time) | Publishable (`sb_publishable_…`) or legacy anon key. Designed to be public. |
| `VITE_PUBLIC_SITE_URL` | hosting (optional) | Public origin used in registration links, pass links and QR codes. Defaults to the serving origin. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | your terminal only | Used by `npm run staff:create` to create staff accounts. Never commit them. |

---

## Supabase project setup (production)

1. **Create a project** at supabase.com. Note the project ref, URL and publishable key
   (*Project Settings → API Keys*).
2. **Apply the migrations** from this repository:
   ```bash
   npx supabase login                       # opens a browser, or set SUPABASE_ACCESS_TOKEN
   npx supabase link --project-ref <ref>    # asks for the database password
   npx supabase db push                     # applies supabase/migrations/*
   ```
   Alternatively, paste the three files in `supabase/migrations/` in order into the SQL editor.
3. **Authentication settings** (*Authentication → Sign In / Providers*):
   - **Allow new users to sign up: OFF.** Staff accounts are created by administrators only.
   - Email provider: **enabled** (email + password sign-in).
   - Anonymous sign-ins: off.
   - *Authentication → URL Configuration*: set **Site URL** to your public site (e.g. `https://passes.example.org`)
     and add `https://passes.example.org/account` to the redirect allow list (password reset).
   - For reliable invite and reset emails, configure custom SMTP (*Authentication → SMTP*). The built-in sender is
     heavily rate limited.
   - Recommended: password minimum 10 characters with letters and digits (matches the app's own check).
4. **Data API**: keep `public` as the only exposed schema. Never expose `private`.
5. **Verify the rate-limit IP source** after deployment (see [Known limitations](#known-limitations)): sign in as an
   administrator and open **Staff**. The "Deployment check" line at the bottom should read `cf-connecting-ip` on
   Supabase Cloud.

### First administrator (bootstrap)

There is deliberately no public way to become an administrator. Use either option.

**Option A, script (recommended):** run on a trusted machine with the project's secret key:

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=sb_secret_... \
  npm run staff:create -- --email owner@example.org --admin
# prints a one-time temporary password; change it under Account after signing in
```

**Option B, dashboard + SQL:** create the user under *Authentication → Users → Add user* (tick "auto confirm"),
then in the SQL editor:

```sql
select private.bootstrap_admin('owner@example.org');
```

### Adding more staff

1. The administrator creates the account with `npm run staff:create -- --email person@example.org`, or invites
   the person from *Authentication → Users → Invite*. An invited person opens the email link, chooses a password,
   and lands in the dashboard.
2. On the event's **Staff** tab, an organizer assigns the person by email as an **operator** (scanning only).
   Only administrators can assign organizers.
3. Administrators can grant or revoke administrator rights under **Staff** in the top navigation.

---

## Deploying the frontend

The frontend is a static SPA. Any HTTPS static host works. The camera requires HTTPS.

**Vercel** (`vercel.json` included: SPA rewrites, CSP and security headers, asset caching):

1. Import the GitHub repository in Vercel. Framework: Vite. Build: `npm run build`. Output: `dist`.
2. Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` and, optionally, `VITE_PUBLIC_SITE_URL`.
3. Deploy, then add the deployment URL to Supabase *Site URL / Redirect URLs*.

**Netlify:** `netlify.toml` is equivalent. Set the same environment variables.

The CSP allows API calls to `https://*.supabase.co`. If you use a custom Supabase domain, update `connect-src` in
`security-headers.mjs`, `vercel.json` and `netlify.toml`.

---

## Using PassSystem

**Organizer**
1. Sign in at `/login` → **Create event** (name, date/time in the event's time zone, location, registration
   window, capacity).
2. **Publish**, then on the event **Overview** use **Copy link**, **Download QR poster** or **QR only (PNG)**.
3. Watch live stats: registrations, checked in, remaining, admission rate. They refresh automatically.
4. **Attendees** tab: search, filter by status, **Export CSV**, **Revoke** or **Restore** a pass, or **Reissue** a
   lost pass. Reissue creates a new QR; the old one stops working immediately.
5. **Staff** tab: assign operators. **Activity** tab: every scan attempt.
6. Set the event's status to **Archived** to hide it. All data is kept. Events that have registrations cannot be
   deleted.

**Attendee:** open the link or scan the poster QR → enter first and last name (email optional) → **Register** → the
pass appears immediately. **Save QR** saves an image (share sheet on phones). **Copy pass link** copies the link,
which reopens the pass on any device. Show the QR at the door.

**Door operator:** sign in → **Scan** → choose the event → **Start camera** → point at the pass.
- **GREEN ADMITTED**: name, event and check-in time.
- **RED**: already used (shows the original check-in time), revoked, wrong event, or invalid.
- **AMBER NOT VERIFIED**: network or server problem. Do **not** admit. Tap **Retry**.

If the camera fails, type the code printed under the QR (e.g. `87J8-13AZ-…`) into manual entry.

---

## Testing

```bash
npm run typecheck && npm run lint
npm test                      # unit + component tests (jsdom)
npm run db:start              # required for the next two
npm run test:integration      # RPCs, RLS, privileges, concurrency, rate limits (real local Supabase)
npm run test:e2e              # Playwright: production build + preview server + fake camera
npm run build && npm run check:bundle-secrets
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push and pull request.

---

## Known limitations

- **Rate limiting is IP-based and best-effort.** On Supabase Cloud the client IP comes from `cf-connecting-ip`,
  which Cloudflare sets. Self-hosted deployments without Cloudflare must run
  `update private.settings set value = 0 where key = 'trust_cf_connecting_ip';`. Attendees on shared venue Wi-Fi
  share one IP, so the defaults are generous (30/min, 400/h per IP; 600/min per event) and can be tuned in
  `private.settings`. There is no CAPTCHA yet. A Cloudflare Turnstile or hCaptcha integration is the recommended
  next step if spam becomes a problem.
- **No offline admission mode**, by design: one-time admission needs a single source of truth.
- **No pass emails.** The email field is stored for the organizer. Sending passes by email is a deferred
  enhancement.
- **Live statistics poll** every 10–15 s rather than using Supabase Realtime.
- **Undoing a check-in** (an admitted pass back to unused) is not implemented. An admitted pass cannot be revoked.
- Staff accounts are created from the Supabase dashboard or the CLI script; there is no in-app "invite user"
  screen. That would need an Edge Function holding the secret key.
- Organizers can find out whether an email has a staff account when assigning staff (minor account enumeration
  limited to trusted organizers).
- The camera scanner is tested in Chromium with a simulated camera. Test on real iOS Safari and Android Chrome
  devices before the first event. See the checklist in `docs/CODEX_HANDOVER.md`.

## Design tokens

All colours, radii, shadows and control sizes live in `src/styles/tokens.css`, in three layers:

1. **Primitives** (`--palette-*`): raw values, never used directly by components.
2. **Semantic** (`--color-*`, exposed as Tailwind utilities): `bg-canvas`, `bg-surface`, `text-fg`,
   `text-fg-muted`, `border-line`, `bg-primary`, `text-brand`, `bg-success-soft`, `text-danger-fg`…
3. **Component** (`--radius-control`, `--radius-card`, `--shadow-card`, `--control-*`, `--nav-*`): shapes and
   sizes used by `src/components/ui`.

Pages use only semantic utilities and the shared components (`Button`, `IconButton`, `Card`, `Badge`, `Alert`,
`SegmentedControl`, fields). Icons come from `lucide-react`. Raw hex values remain only where a brand or export
requires them (Google Wallet button artwork, QR poster canvas).

The look is **Sand & Teal**: warm sand canvas, deep teal primary. The scanner (`/scan`) uses **Midnight**, a dark
theme applied by the `.theme-night` class on the admin layout. It redefines layer 2 only, so every component
switches without its own dark variant. Fonts are self-hosted (Plus Jakarta Sans, plus IBM Plex Sans Arabic for
Arabic) because the CSP allows `font-src 'self'` only; `vite.config.ts` keeps fonts out of inlining for the same
reason. `src/styles/tokens.test.ts` fails the build if a page uses a raw Tailwind colour class.

## Languages

Guest pages (`/`, `/e/:slug`, `/pass`) are available in English and Arabic. A switch in the header changes the
language; the choice is remembered on the device (`passsystem.lang` in localStorage). Arabic pages run
right-to-left (`<html dir="rtl">`) and use Latin digits. Strings live in `src/lib/i18n.ts`; the `ar` dictionary
must have every `en` key (type-checked). Staff pages stay in English. Event text written by the organizer (name,
description, attendance terms) is shown as written.

The Arabic strings were written without a native-speaker review; have one check them before relying on them.

Passes include **Add to calendar**: an `.ics` file built in the browser (`src/lib/calendar.ts`) with the event
time, venue and the pass link. Its UID is derived from a hash of the pass token, not the token itself.
