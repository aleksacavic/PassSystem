# PassSystem verification review 10

Reviewed **5674a96**, changes **aa90c82..5674a96**, on 29 October 2026. **Result: one Medium finding.** Normal stale-form updates are refused, archived passes/Wallet responses are corrected, and migration 011 preserves the earlier registration body after its rate checks. An unsuccessful initial event load still leaves a save path without the expected version.

Only this report is committed. Application source was not modified. Migration 011 was applied only to the existing local stack and its local Edge runtime restarted. Fixtures and historical copies were kept in ignored artifacts or `/tmp`. Production, hosted settings and production secrets were not accessed. The newer documentation commit `1ef873e` was preserved but is outside the reviewed head.

Following the user's subsequent direction, additional security-specific reruns and historical database/Edge mutations were not performed. Ordinary UI, availability, timestamp and rate-bookkeeping checks were completed. The report distinguishes executed checks from static verification and unexecuted counterfactuals; it does not claim a complete historical failure matrix.

## Finding

### R10-01 — Medium — A failed initial event load still permits a save without a version

**Location:** `src/pages/admin/EventFormPage.tsx:49–55`, `:74–76`, `:101–104`; `src/lib/api.ts:132–136`.

When `getEvent()` fails, the page displays the error but clears `loading`, leaves `original` null, and renders the editable default form. The save path supplies `{updatedAt: original?.updated_at}`. With no loaded event, that value is undefined, so `updateEvent` adds no expectation filter and updates by ID alone.

**Concrete reproduction:** Using the real EventFormPage and actual `updateEvent`, with deterministic mocked loading/database transport:

1. The current stored event is archived.
2. Make the initial `getEvent()` reject with a temporary load error. The page shows the error and an editable blank form.
3. Complete its required name, link, start and terms fields, then submit.
4. The actual API builds an update with the ID filter but **no `updated_at` filter**. The fixture is saved as **draft**, replacing its archived state and other values with the submitted/default form values.

Observed assertion result: **`{guarded:false, status:'draft'}`**, versus the expected guarded update with the stored event remaining archived. This is an ordinary load-error/data-consistency problem for an otherwise authorized editor, not a change in who is allowed to edit. The probe used the real component and API code, not a real backend write for this failure case.

**Suggested fix:** Do not render/enable editing an existing event until its original version has loaded successfully; provide a retry/error state instead. Require `original` before submitting an edit. Make the update expectation mandatory for normal application writers, with a type requiring a version or status, rather than accepting an empty/default expectation. Add a load-failure→complete-form→Save regression alongside the normal stale-form test.

## R9 findings – fixed? yes/no/partly

| Finding | Fixed? | Verification |
| --- | --- | --- |
| R9-01 | partly | A successfully loaded edit form preserves the exact timestamp and refuses the original stale-form-after-archive schedule. Archive/Restore/Publish pass their displayed status. Initial load failure still permits an update without a version: R10-01. |
| R9-02 | yes | Archived registered passes show Not active and hide the calendar/image/Wallet actions. Local Wallet lookup refuses archived events, the Edge endpoint returns 409, and draft/published/closed permit existing unused passes and Wallet saves consistently with scanning. |
| R9-03 | yes | All five local settings match 011; hourly and minute responses are distinct. A minute-limited attempt leaves the hourly counter unchanged. Earlier registration logic after the rate checks is textually identical to 009 and the complete current integration suite passes. Raised values are starting capacity assumptions, not a crowd load-test result. |

## Event-update verification

A UI-path probe mounted the real EventFormPage with the actual `updateEvent` implementation and a deterministic database transport. After successful load, another actor's archive/version change was represented in that transport. Saving through the actual form displayed the conflict message and retained the archived state. The outgoing timestamp filter preserved **`2026-10-29T08:00:00.123456+00:00`** exactly. The checked-in integration test separately exercises the equivalent conditional update against real local Postgres/PostgREST. This was not a two-browser end-to-end race test.

`original.updated_at` is retained as a string, separate from the date/time fields transformed by the form. It is not passed through JavaScript Date or shortened to milliseconds. Local Postgres checks confirmed that the same six-digit instant expressed as `08:00:00.123456+00:00` and `12:00:00.123456+04:00` compares equal; truncating to `.123Z` does not. The current real-database fresh-version test passes, complementing the component/query-shape checks.

The production frontend source has three event-update call sites: the edit form, EventsPage Archive/Restore, and EventDetailPage Publish. The latter two provide their displayed status. No additional frontend event UPDATE writer without an expectation was found. Creation/deletion are separate operations. The helper still permits omission of its optional expectation; R10-01 is a reachable instance of that weakness.

Status expectations intentionally protect a **change of status**, not every intervening metadata edit or a status that changes away and then back. The timestamp-based form expectation detects intervening updates while the loaded timestamp remains different. These are optimistic client-write conditions, not a new database prohibition on owner/direct status changes. A zero-row result with an expectation becomes `edit_conflict`; the UI preserves the error instead of treating it as a successful save.

## Pass / Wallet / scanner agreement

Ordinary local availability fixtures used a separate previously unused pass for each event state:

| Event status | Pass lookup reports | Wallet data / local Edge response | New authorized scan |
| --- | --- | --- | --- |
| draft | registered pass, draft event | Allowed / HTTP 200 | admitted |
| published | registered pass, published event | Allowed / HTTP 200 | admitted |
| closed | registered pass, closed event | Allowed / HTTP 200 | admitted |
| archived | registered pass, archived event | `event_archived` / HTTP 409 | `event_archived` |

The page derives usability from registered status **and** a non-archived event. On archived data it shows Not active, explains entry is unavailable, and hides calendar, image, Wallet and copy-pass actions. The checked-in real-page tests pass. Used/revoked passes retain their respective labels and remain non-usable rather than being relabeled Valid. Draft deliberately permits existing passes and scanning; closed closes registration rather than admissions.

The checked-in local integration test verifies archive→draft restores Wallet lookup. The ordinary status matrix also exercised the real local Wallet Edge endpoint successfully for draft. No Google Wallet object was actually saved or remotely changed; existing saved objects still require separate remote-update handling if their presentation must change.

The new confirmations accurately describe the unused-pass flow: archive closes registration, retains data and prevents new scans; Restore as draft immediately permits retained unused passes while registration stays closed. Two qualifications remain: used/revoked passes keep their more specific labels, and an already open pass page changes after its normal reload/visibility refresh, not via an instantaneous push notification. Existing in-flight server operations are not retrospectively cancelled by the confirmation.

## Migration 011 and registration behavior

011 applied successfully to the populated local 010 database. It replaces existing function signatures and updates settings; it does not rewrite registrations/history or add column backfills. Both replaced functions retain empty search paths, and `CREATE OR REPLACE` preserves their existing function privileges. The migration adds no grant/revoke or signature change. No extra role/permission probes were run after the user's direction; the completed current integration suite is the execution evidence here.

The following values were observed locally after standard suite teardown:

| Setting | Value |
| --- | ---: |
| register_per_ip_per_minute | 600 |
| register_per_ip_per_hour | 6000 |
| register_per_event_per_minute | 1200 |
| pass_lookup_per_ip_per_minute | 3000 |
| public_event_per_ip_per_minute | 3000 |

A rolled-back ordinary bookkeeping check prefilled the minute bucket to 600 and the hourly bucket to one. Calling the current registration function returned `window:'minute'`; the hourly bucket remained **one**. The sequential early return therefore avoids charging the hourly quota for a minute-limited request. The current integration test separately passes for hourly refusal and minute refusal. Hourly refusals become `rate_limited_hour` in the frontend, with approved English/Arabic messages saying to try later or use mobile data. The counters remain fixed calendar windows, not rolling-hour counters, and no precise retry-after time is added.

A direct source comparison found the complete registration body **from `if p_website is not null` onward identical to migration 009**. Thus the change is confined to the earlier rate checks, preserving the implementation of:

- R2-03: current terms-version comparison and replay-before-current-terms ordering.
- R2-05: legacy retry-key handling and attendee-detail binding.
- R2-06 / R3-01: capacity advisory lock followed by shared event-row reread, without reinstating the old event-update advisory trigger.
- R4-06: NFC comparison of legacy names.

The full current integration suite passed these earlier regression groups. Historical database-body mutations were not rerun after the user's direction; textual identity plus current-suite execution is the stated evidence, not a new pre-fix sensitivity result. The migration's literal settings test alone is not a crowd performance test; the additional local settings observation confirms the applied values.

## Tests and sensitivity

The requested **`npm run test:all`** was run locally before the user's instruction to avoid further rejected checks:

| Check | Result |
| --- | --- |
| Typecheck / lint | Passed |
| Unit | 119/119 passed, 24 files |
| Integration | 138/138 passed, 15 files |
| Default Playwright | Nine launch failures: configured `chromium_headless_shell-1243` executable absent |
| Subsequent ordinary browser subset with installed Chromium | 4/4 passed, 38.9 seconds: main organizer/guest/scanner workflow, unavailable-server scanner state, denied camera permission, Wallet workflow |

The default command did not exit successfully as written. Five other browser cases were not rerun with the fallback after the user's direction; **this review does not claim 9/9 browser tests passed**. Additional security-specific reruns were omitted. Application source remained unchanged.

**L** restores literal previous implementations in isolated copies; **M** adapts a test transport contract or restores faulty behavior while retaining today's API. Only executed historical checks are counted below.

| Test / group | Historical result / evidence | Classification |
| --- | --- | --- |
| Four new `api.updateEvent` unit cases | L: previous API body; M transport adapter supplies the old `.single()` method and its normal zero-row error, avoiding meaningless missing-method failures. All four fail their filter/conflict/no-permission assertions. | Two expectation-shape regressions and two response-contract checks |
| Archived PassPage test | L: previous page. Fails because Valid/actions remain. | Finding reproduction |
| Published PassPage control | Same L page. Passes. | Invariant/control |
| Modified EventsPage archive/restore assertions | L: previous card. Both fail because the third expectation argument is absent. Cancellation/error-display cases still pass. | Wiring regressions plus invariant guards |
| Modified hourly i18n assertion | L: previous dictionary/helper. Fails the hourly translation assertion; interpolation test passes. | Message regression |
| Three new conditional-update integration cases | Current real-DB tests pass. They describe conditional SQL already available before the fix, as the remediation map acknowledges. | Database invariant guards; not evidence that the old UI supplied those filters |
| New retention and other-event-organizer integration cases | Current tests pass; underlying retention/permissions were unchanged. | Invariant guards |
| Wallet and rate integration counterfactuals | Current tests pass; separate historical DB/Edge mutations not executed in this review after user direction. | Historical sensitivity not independently confirmed |

The executed historical unit subset produced **8 failed / 4 passed**. The new migration-source settings test cannot meaningfully be called a literal pre-fix reproduction simply because its newly named file did not previously exist. No missing-file failure was counted. The completed full integration run and ordinary availability checks establish current behavior; they do not replace the unexecuted historical matrix.

The additional real-form/API probe passes for normal stale edits and intentionally fails for the load-error save in R10-01. Its database transport is mocked; the current integration tests provide the real PostgreSQL condition checks. No extra probe or mutation file is included in the commit.
