# PassSystem: Test Results

> **Update after audit #1 remediation:** unit 49/49, integration 79/79 (incl. 18 audit regression tests and 7
> invite tests, now including the edge runtime and Mailpit), E2E 7/7, build and secret scan clean. See
> [`AUDIT_REMEDIATION.md`](AUDIT_REMEDIATION.md). The sections below describe the original run.

Run date: 2026-10-28 · Branch `claude/passsystem-implementation-h1i74q`

## Environment

| Component | Version |
| --- | --- |
| Node.js | 22.22.0 |
| Supabase CLI | 2.122.0 (local stack: `supabase/postgres:17.11.0.006`, `gotrue v2.197.0`, `postgrest v16.5`, `kong 2.8.1`) |
| Vitest | 5.0.5 (jsdom for unit tests, node for integration tests) |
| Playwright | 1.63.0, Chromium (headless) |
| Services excluded locally | studio, storage, realtime, edge-runtime, analytics, mail, pooler (not used by the app) |

Integration and E2E tests run against the **real local Supabase stack**: Postgres, GoTrue auth, PostgREST and
the Kong gateway. Nothing is mocked. Unit tests mock the API only in the RegisterPage component test.

## Summary

| Check | Command | Result |
| --- | --- | --- |
| Type checking | `npm run typecheck` | ✅ 0 errors |
| Lint (ESLint 10 + typescript-eslint + react-hooks 7) | `npm run lint` | ✅ 0 problems |
| Unit + component tests | `npm test` | ✅ 35 / 35 passed (10 files) |
| Integration tests (local Supabase) | `npm run test:integration` | ✅ 54 / 54 passed (4 files) |
| End-to-end (Playwright, production build + CSP) | `npm run test:e2e` | ✅ 5 / 5 passed |
| Production build | `npm run build` | ✅ ~180 kB gzip initial JS. Scanner and wasm are lazy-loaded. |
| Bundle secret scan | `npm run check:bundle-secrets` | ✅ No privileged keys or JWTs in `dist/` |
| CSP violations during E2E | asserted in `workflow.spec.ts` | ✅ none |

## Mapping to the brief's required tests

### Functional

| Requirement | Test(s) |
| --- | --- |
| Create event | E2E `organizer → attendee → …` (UI form). Integration helpers create events through RLS as an admin. |
| Publish event | E2E (Publish button). Integration `hides draft and archived events from the public`. |
| Open public registration link | E2E (attendee context with iPhone 13 emulation) |
| Submit first + last name | E2E. Integration `registers without email and issues a 120-bit token` |
| Register without email | Integration `registers without email…`. E2E (Ana) |
| Register with email | Integration `registers with email (normalized to lowercase)`. E2E (Marko) |
| Generate a unique QR pass | Integration `issues unique passes for people with the same name`, `tokens are uniformly random… (no collisions in 5000)`. E2E checks the QR image. |
| Open a saved pass link | E2E (pass URL opened in a separate browser context). Integration `get_pass returns pass and event without sensitive fields` |
| Scan valid pass | E2E (**camera**: fake video stream of the pass QR → zxing-wasm → green). Integration `admits a valid pass once…` |
| Reject second admission | E2E (camera re-scan → ALREADY USED). Integration `…then reports already used with the original time` |
| Reject wrong-event admission | E2E (Event A pass at Event B → WRONG EVENT). Integration `rejects a pass from another event…`, `a pass from Event B cannot admit to Event A…` |
| Reject revoked pass | Integration `rejects revoked passes; restore makes them valid again` |
| Separate passes for separate events | Integration `gives independent passes for separate events`. E2E attendee lists per event. |
| Statistics update | Integration `updates event statistics`. E2E stats cards (1 registered, 1 checked in, 100%). |
| Export attendee CSV | E2E (download contains only Event A attendee). Unit `csv` (quoting, formula injection). |
| Unauthorized users cannot access protected records | Integration `anonymous users *`, `unassigned staff see no events, registrations or logs`. E2E `unauthenticated users are sent to sign-in` |

### Concurrency

| Requirement | Test |
| --- | --- |
| Two independent operator sessions scan the same pass simultaneously: exactly one succeeds | `two operator sessions scanning the same pass at the same time: exactly one admission` (10 rounds) |
| Additional | `a burst of 20 concurrent scans of one pass admits exactly once` (1 admitted + 19 already_used logged). `a scan that arrives while another admission is uncommitted waits and then reports already_used` (deterministic row-lock interleaving with two Postgres sessions). `serializes concurrent duplicate requests into one registration`. Capacity race: 8 parallel registrations against `max_attendees = 3` → exactly 3 succeed. |

### Security

| Requirement | Test |
| --- | --- |
| Anonymous users cannot list registrations | `cannot read any table` (all 5 tables → 42501) |
| Anonymous users cannot call privileged operations | `cannot call privileged functions` (10 RPCs). `anon can execute only the three public attendee functions` (catalog check) |
| Public clients cannot mark their own passes admitted | `cannot write any table`. `admit_pass … requires authentication` |
| QR tokens cannot feasibly be guessed | 120-bit tokens; `tokens are uniformly random over the Crockford alphabet`; `does not find guessed or malformed tokens`; `limits pass lookups (token guessing)` |
| Secrets not exposed in frontend builds | `npm run check:bundle-secrets`. `nobody can read credential hashes through the API` |
| Unauthenticated users cannot access scanner operations | `requires authentication`. E2E redirect to `/login` |
| Operators cannot administer unassigned events | `rejects staff who are not assigned to the event`. `operators can scan but not read attendee lists or administer the event`. `organizers manage only their own events`. `organizers cannot downgrade another organizer…` |
| No SQL injection or stored XSS via registration input | `rejects stored-XSS payloads and stores SQL-looking input literally`. `validates input server-side`. React escaping (no `dangerouslySetInnerHTML`) |
| Public registration is rate-limited | `limits registrations per client IP and cannot be bypassed with spoofed headers` |
| Sensitive data not unnecessarily logged | `logs every attempt without raw tokens`. `never stores the raw token`. Rate-limit buckets store salted IP hashes (asserted). |
| Additional hardening | `every public table has RLS enabled`. `every SECURITY DEFINER function pins search_path`. `cannot forge created_by…`. `only administrators grant administrator rights`. `cannot sign up`. Open-redirect unit test. |

### Reliability

| Requirement | Test |
| --- | --- |
| Camera permission denial | E2E `scanner explains a denied camera permission and keeps manual entry` |
| Network interruption / unsuccessful backend response | E2E `scanner shows amber "not verified" when the server cannot be reached` (request aborted → amber, never green; Retry → definitive answer) |
| Invalid credentials | Integration `rejects invalid and malformed credentials`. Unit `extractPassToken rejects unrelated QR content` |
| Duplicate requests | Unit `submits exactly once on rapid repeated taps`, `reuses the idempotency key when retrying after a network failure`. Integration replay tests. `ScanGate` unit tests. E2E: one `admit_pass` request in 5 s while the QR stays in view. |
| Unsupported browsers | Handled in code (`useCameraScanner` → `unsupported` state + manual entry). Not automated. |

## E2E stability

The E2E suite was run 6 more times back to back after the final changes: **30/30 test runs passed**.
Two intermittent failures were seen before that:

1. **Fixed.** A strict-mode selector race in the test. The operator's event card also contains a "Scan" link, so
   `getByRole('link', { name: 'Scan' })` sometimes matched two elements. The test now scopes the click to the main
   navigation.
2. **Fixed (root-caused in CI).** An `expect(page).toHaveURL(/pass#…/)` timeout in the main workflow. The failure
   screenshot showed "Too many attempts from this network". The integration suite runs with lifted rate limits,
   but its counters kept accumulating (63 registrations in one minute). Teardown restored the 30/min default
   without clearing them, so an E2E run in the same clock minute was rate limited. This was reproduced
   deterministically by running the two suites back to back. Integration teardown now clears the counters, and
   the E2E global setup starts from empty counters. The rate limiter itself behaved correctly.

## Not yet tested

- **Real devices.** The camera path is verified in headless Chromium with a simulated camera (the zxing-wasm
  decoder path, the same one iOS Safari uses). iOS Safari, Android Chrome (native `BarcodeDetector`), torch, and
  real lighting conditions still need manual verification over HTTPS after deployment.
- **Hosted Supabase specifics.** The `cf-connecting-ip` header source for rate limiting and the auth email
  delivery (SMTP).
- **Load.** No load test beyond the concurrency bursts above.

## Raw output (abridged)

```
Unit:         Test Files 10 passed (10) · Tests 35 passed (35)
Integration:  Test Files 4 passed (4)   · Tests 54 passed (54)
E2E:
  ✓ organizer → attendee → operator camera scan → event isolation → reporting (20.6s)
  ✓ unauthenticated users are sent to sign-in for staff pages (0.7s)
  ✓ scanner shows amber "not verified" when the server cannot be reached (2.1s)
  ✓ scanner explains a denied camera permission and keeps manual entry (2.3s)
  ✓ invited staff member sets a password from the invite link and can sign in (1.9s)
  5 passed (38.7s)
Build:        ✓ built · ✓ No privileged secrets found in 16 files under dist/.
```
