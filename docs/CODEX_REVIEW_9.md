# PassSystem verification review 9

Reviewed **64cd8bd** on 29 October 2026, including `e399b4b` and the explicitly requested archive feature `6e7af0f`. The latter is already an ancestor of `5a5e539`, so it is not in the literal `5a5e539..64cd8bd` diff; its feature diff and tests were reviewed separately.

**Result: three Medium findings**, including one configuration/availability risk under the supplied crowd scenario. R8-01 is fixed in the tested cases. No authorization bypass was established for archive/restore.

Only this report is committed. Application/deployment source and database functions were not changed. All probes used disposable local fixtures; production, hosted settings and production secrets were not accessed. Proposed rate values were **not applied**. Standard local test setup temporarily lifts/restores its own limits; the independent rate probe used explicit limit arguments and rolled back its counters without updating settings. The stated production values are user-supplied context, not remotely verified observations.

## Findings

### R9-01 — Medium — A stale edit form can silently undo an archive

**Location:** `src/lib/eventForm.ts:112`, `src/pages/admin/EventFormPage.tsx:74`, `src/lib/api.ts:116–122`; interacting new card action at `src/pages/admin/EventsPage.tsx:154`.

The edit form sends its previously loaded status even when only another field was changed. Updates filter only by event ID, with no version or expected-status check. An archive completed from the new menu can therefore be overwritten by an older edit form without an explicit decision to republish.

**Concrete reproduction:** Using authorized clients against a disposable local event:

1. Load a published event into an edit form, capturing `status:'published'`.
2. Another organizer archives it. Confirm the stored state is `archived`.
3. Save the old form with a name change and its unchanged, stale `status:'published'`—the payload shape produced by `validateEventForm`.

Observed: one row updated successfully, status returned to **published**, and anonymous `get_public_event` succeeded again. The save had no conflict warning. This was reproduced with real local REST updates, not merely a mocked UI callback. Similar last-writer-wins behavior can overwrite a restore or a newer lifecycle decision from a stale card.

**Suggested fix:** Use optimistic concurrency consistently across event writers, for example an expected `updated_at`/version checked atomically with the update and an explicit conflict response. Sending only dirty fields prevents an unchanged status from being resubmitted, but explicit conflicting lifecycle edits still need a version/status guard. Add a stale-form-save-after-archive regression with the public event remaining unavailable until a fresh, intentional publish.

### R9-02 — Medium — Archived passes still advertise validity and receive ACTIVE Wallet saves

**Location:** `src/pages/public/PassPage.tsx:139` and `:341–359`; `supabase/migrations/20261028000003_functions.sql:478–489`; `supabase/migrations/20261028000005_wallet.sql:27–51`; `supabase/functions/_shared/googleWallet.ts:104`.

Archiving stops new registration and scanning, but the issued-pass presentation considers registration status alone. An unused pass for an archived event remains labeled **Valid**, and the Wallet endpoint still signs an **ACTIVE** object. Event archival does not revoke the registration, so neither path notices that entry has been disabled.

**Concrete reproduction:** Register two guests, admit the first, then archive the event as its organizer:

- Anonymous registration-event lookup and new registration return `event_not_found`.
- Anonymous `get_pass` for the second, unused pass still returns `ok:true`.
- The actual local Google Wallet Edge endpoint returns HTTP **200**; decoding only its local signed payload shows `eventTicketObjects[0].state === 'ACTIVE'`.
- A new operator scan is refused with `event_archived`.

A separate real-PassPage component probe, supplied that archived-event/registered-pass response, failed the assertion that no **Valid** badge is shown: the badge remains visible. The Wallet test did not contact Google or publish/save an object; it verified the locally generated signed link.

This is inconsistent attendee-facing validity, not a scanning authorization bypass. It also qualifies the menu's claim that guests can no longer open the event: the registration page is hidden, while existing token holders still open their pass and event details.

**Suggested fix:** Model event availability separately from retained registration history. Display archived/unavailable state on existing pass pages, avoid presenting them as currently usable for entry, and refuse new active Wallet saves for archived events. Do not destroy history or automatically revoke/rotate every credential merely to implement a temporary archive. Existing saved Wallet objects will need a separate update strategy if they must visually change; backend scanning must remain authoritative. Add an archive→pass-page/Wallet/scanner consistency test.

### R9-03 — Medium — Supplied shared-IP limits are too low for a venue arrival rush

**Location:** `supabase/migrations/20261028000001_core_schema.sql:160–163`; active registration checks at `supabase/migrations/20261029000009_review4_remediation.sql:254–256`; pass checks at `supabase/migrations/20261028000003_functions.sql:462–466`.

This is an operational availability risk for the explicitly requested on-site scenario, not a new change in these commits. The supplied settings allow only **30 registration attempts/minute**, **400/hour**, and **120 pass lookups/minute per fingerprint**, shared across events. With trusted `cf-connecting-ip`, that fingerprint still identifies a public network address, not an individual guest behind Wi-Fi NAT or carrier NAT. IPv6 clients are grouped by /64.

**Concrete failure scenario:** One thousand people arrive over ten fixed-minute windows behind one venue egress address. Even assuming one valid request per person and no retries, the 30/minute registration ceiling allows at most **300** attempts through in that interval; the remaining demand exceeds the quota. A faster cohort exhausts it sooner. A preregistered crowd opening 300 fresh pass links in one minute exceeds the 120-lookup limit by 180 calls. If arrivals continue, the hourly registration ceiling can bind even after the next minute resets. Its shared `rate_limited` message tells people to wait a minute, although the hourly window may not reset for much longer.

The real fixed-window helper was exercised with fresh disposable buckets and the explicit supplied values: 31 calls allowed **30**, 401 hourly calls allowed **400**, and 121 pass calls allowed **120**. Counters were rolled back; settings were not changed. These are deterministic boundary checks, not a load benchmark or a production incident reproduction.

**Suggested fix:** Size shared-network quotas for the expected cohort and retry budget, rather than using these defaults as per-person limits. Recommended starting values and assumptions are below. Preserve abuse controls and distinguish the limiting window/retry time in responses. Raising a quota increases permitted abuse and must be supported by measured database/Edge capacity; no capacity result is claimed here.

## R8 findings – fixed? yes/no/partly

| Finding | Fixed? | Verification |
| --- | --- | --- |
| R8-01 | yes | `has`/`missing` rules no longer provide unconditional baseline coverage. Conflicting conditional values still fail. Independent global-condition, scoped-conflict and unknown-rule-property mutations for both providers failed as expected. The new test fails against the literal preceding checker helpers. |

## Archive / restore behavior and permissions

### Authorization and confirmation

Direct local REST attempts by an assigned **operator** and an **organizer assigned only to another event** updated zero rows for both `archived` and `draft`; the target remained unchanged. This demonstrates database RLS enforcement, not just hidden controls. The assigned organizer could archive, and a separate global administrator with no target-event assignment could restore. These follow the existing organizer UPDATE policy and `private.is_event_organizer` helper; the feature introduces no privileged client or service-role call.

The menu is shown only for the server-returned admin/organizer role. Its native confirmation precedes the API call. Checked-in UI tests passed for confirm→archive→reload, cancellation with no API call, restore-as-draft and a rejected update displayed as an error. The actual API requests a returned row with `.single()`, so a zero-row RLS denial is an error rather than a successful archive. The error display is on the staff page, not a guest diagnostic boundary.

### Guest/scanner lifecycle matrix

Observed against disposable local data:

| Operation / data | Archived | Restored as draft |
| --- | --- | --- |
| Anonymous registration-event lookup | `event_not_found` | `event_not_found` |
| New anonymous registration | `event_not_found` | `event_not_found` |
| Existing token-holder pass lookup | Succeeds | Succeeds |
| New Wallet save-link request for unused pass | HTTP 200, signed ACTIVE object | HTTP 200, signed ACTIVE object |
| New authorized scan | Refused: `event_archived` | Allowed; previously unused pass admitted |
| Existing registrations, assignments and history | Kept | Kept |

**Restore as draft is not a reset or a continued scanning suspension.** It hides public registration but re-enables scanning of retained passes before republishing, because `admit_pass` blocks `archived`, not `draft`. Existing pass links and event details remain available to token holders. Previously checked-in passes remain used; revocations, capacity usage, terms acceptance/history, staff assignments and old credentials are not cleared by a status-only update. Anyone expecting a fresh event/attendance cycle needs a separate event, not archive/restore.

The retention fixture had two registrations and one admitted guest before archive. After restore, the second guest could be admitted, yielding two retained registration rows, two admission-log rows and three staff-assignment rows. The original history was not deleted. No Google Wallet object was actually saved or remotely updated, and existing saved objects are not automatically invalidated by this status update. R9-02 concerns the misleading new pass/Wallet presentation while archived.

### Races

The complete integration suite includes the two R2-06 ordering regressions. An archive holding the event row makes a registration wait; after archive commits, registration re-reads the event and returns `event_not_found` without inserting. Conversely, the shared event-row lock held by an in-progress registration delays archive until the registration finishes. These cases passed; no new capacity-lock ordering is introduced by the menu.

This is transactional ordering, not cancellation of work already accepted before archive. A registration that wins that ordering may finish and retain a pass immediately before archival. Likewise, an admission already in flight is not a revocation operation; fresh calls after archival are refused. The separately reproduced stale-edit overwrite is not prevented by those row locks because the old form's later UPDATE deliberately supplies its stale status: R9-01.

## Crowd rate-limit recommendations — report only

Treat the supplied `trust_cf_connecting_ip=1` as correct **only behind an ingress that overwrites client-supplied values**. It recovers the client's public address through a trusted proxy; it does not recover private device addresses behind NAT. Turning it off is not a solution to crowd sharing and can collapse traffic onto a proxy/unknown identity. The production trust boundary was not probed in this review.

For a pilot sized around **1,000 arrivals in ten minutes behind one egress**, allow two registration attempts per attendee and additional burst margin:

| Setting | Supplied/current default | Recommended starting value |
| --- | ---: | ---: |
| `register_per_ip_per_minute` | 30 | **600** |
| `register_per_ip_per_hour` | 400 | **6,000** |
| `pass_lookup_per_ip_per_minute` | 120 | **3,000** |
| `public_event_per_ip_per_minute` | 300 default | **3,000**, so initial registration-page loads do not become the next shared-IP bottleneck |
| `register_per_event_per_minute` | 600 default | **1,200**, subject to capacity testing, to allow multiple networks and retry headroom |

These are starting recommendations for that cohort, not universally safe production settings. The base modeled demand is 100 attendees/minute × two registration attempts = 200 attempts/minute. The suggested 600/minute provides a threefold margin over that modeled average; 6,000/hour permits multiple bursts. A one-minute mass release of all 1,000 registrations is a different workload and would still exceed 600/minute. Size larger events from their **peak shared-egress attempt rate**, not their all-day average, and account for carrier NAT combining visitors with unrelated users.

Important implementation effects:

- These are fixed calendar windows, not smooth token buckets; traffic straddling a boundary can burst across both windows. Hourly limits still bind independently.
- Attempts/retries and early validation failures can consume counters before a registration is created. Retries of a legitimate request do not get a free quota exemption.
- The per-event registration ceiling aggregates all networks. Raising only the per-IP limit does not remove it, and initial event lookup has its own limit.
- Pass lookup is a guest retrieval limit, **not** the authorized door-admission throughput limit. `admit_pass` does not use `get_pass`'s 120/minute bucket. Already displayed passes retained after a failed refresh and previously saved offline Wallet QR codes are different from opening a fresh pass URL. In-app navigation immediately after successful registration also has a ready result to show even if its refresh is throttled.
- Maintain token entropy, capacity checks, honeypot and trusted-header handling; consider separate edge/bot controls instead of relying on a small venue-wide quota. Observe error rates/latency under a representative shared-IP burst before selecting final values. The existing per-/64 grouping and partial anti-abuse residual risk remain.

No recommended value was applied, and no production configuration was read.

## Test execution and sensitivity

Ran **`npm run test:all`** against local Supabase:

| Check | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Unit | 113/113 passed, 22 files |
| Integration | 129/129 passed, 14 files |
| Default Playwright | Nine launch failures: configured `chromium_headless_shell-1243` executable absent |
| Complete browser suite using installed `/usr/bin/chromium` and ignored configuration | 9/9 passed, 58.4 seconds |

The default command did not exit successfully as written because of the browser binary; the full browser suite passed with the explicit fallback after the default process exited. Independent archive/Wallet/RLS/stale-edit probes completed locally; the archived-pass component assertion intentionally failed on the current Valid badge. Wallet checks decoded only the disposable locally signed payload and did not contact Google.

**L** restores literal previous frontend/checker code in isolated copies. **M** would restore a faulty behavior while preserving current contracts; no M mutation was necessary here. Missing capabilities in the pre-feature UI are identified explicitly below rather than misreported as backend security regressions.

| New test(s) | Pre-change result | Classification |
| --- | --- | --- |
| R8-01 combined header test | L: `5a5e539` checker helpers with the new test appended. Failed the first global-`has` coverage assertion; seven older tests passed. | Finding reproduction |
| Four EventsPage tests | L: `6e7af0f^` EventsPage with current tests. All four failed because the archive/restore actions were absent. | Feature-availability regressions; cancellation/error branches cannot be independently reached in the old UI |
| Two archive integration tests | Passed against the pre-feature frontend snapshot and unchanged local SQL backend. No migration/backend change exists in the feature range. | Invariant guards: organizers already could update status, operators already could not |

The historical unit run produced **5 failed / 7 passed**. Independently, each current checker mutation failed: global `has`, global `missing`, a conflicting conditional scoped rule, an unknown Vercel property and an unknown Netlify property. The combined historical test stops at its first failed assertion; this matrix verifies the other branches on current code.

Coverage gaps: the archive integration test named “data is kept” inserts assignments but does not create/assert retained registrations or admission logs; the independent retention fixture above covers those for this review. Add checked-in tests for other-event organizers, archived pass/Wallet availability, draft scan semantics, a stale editor saving after archive, and shared-IP arrival bursts. This review's extra probes are not part of the commit.
