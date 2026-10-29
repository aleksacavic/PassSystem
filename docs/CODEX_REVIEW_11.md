# PassSystem verification review 11

Reviewed **350a368**, changes **c10d678..350a368**, for [PR #1](https://github.com/aleksacavic/PassSystem/pull/1). The branch was fetched at the start of review; `350a368` was its code head. The subsequent documentation-only commit `e27754e` was preserved but is outside the code review.

**Result: one Low finding.** The original initial-load failure and unconditional-save defect is repaired. A separate event-ID transition can retain the previous event's editor state. No application source was changed, and no production, database migration, Edge Function or infrastructure changes were performed. Verification used frontend fixtures and the existing local integration stack.

## R10 findings – fixed? yes / no / partly

| Finding | Fixed? | Evidence |
| --- | --- | --- |
| R10-01 | partly | Initial failed load now shows only an error/retry/back state, and the API cannot perform an ID-only update with an empty expectation. Retry saves with the exact loaded version. However, after a route-ID change, `original` can still belong to the previous event, leaving an editable form for a target that failed to load: R11-01. |

**R9-01 assessment:** The exact stale-form-after-archive schedule and the initial-load-error follow-up are now fixed. No normal source caller was found making an event UPDATE without a version or status condition. I would not describe the entire editor lifecycle as fully corrected yet: the loaded record also needs to belong to the current route, as described below. This remaining issue does not restore an unconditional SQL UPDATE.

## Finding

### R11-01 — Low — Changing event IDs retains the previous form when the new load fails

**Location:** `src/pages/admin/EventFormPage.tsx:50–63`, `:80–85`, `:112`.

The load effect cancels late responses correctly, but does not reset `original`, `loading`, or the form when `id` changes. The render and submit guards check only whether an original record exists, not whether its ID equals the current route ID.

**Concrete reproduction:** In a local real-component/router probe:

1. Load event A's edit route successfully.
2. Navigate within the same router to event B's edit route, reusing the component. Direct route transitions can also arise from browser-history jumps between edit URLs.
3. Make B's load reject.
4. The page retains A's editable fields instead of the B load-error/retry screen. Completing the fields and pressing Save calls:

```text
updateEvent('event-b', submittedForm, { updatedAt: eventA.updated_at })
```

The test expected no save and observed that call instead. The API was mocked in this routing probe: a real database update will normally be refused because A and B have different timestamps. Nevertheless, the displayed record and target ID are wrong, and the version predicate is for the wrong record. Timestamps are not globally unique; equal versions are possible, for example for events inserted in one transaction, so record identity must not be inferred from the timestamp alone. No actual cross-event database overwrite was performed or established in this review.

**Suggested fix:** Bind edit state to its route identity. Require `original.id === id` before rendering/submitting an existing-event form, reset the loading/error/original state for each new ID, or remount an editor keyed by ID. Also handle transitions between creation and editing explicitly. Add tests for A loaded → B pending, B failure, and B success, including a no-save assertion until B has loaded.

## Checks found sound

### Initial load failure, retry and response cleanup

The new failure screen renders “This event could not be loaded,” the error, “Nothing has been changed,” Try again and Back; it has no editable form or Save button. `onSubmit` separately refuses an existing-event save with no original record. Try again clears the error, shows loading, increments `attempt`, and loads the event before the save supplies its raw `updated_at` string.

The effect's `current` flag prevents a request from writing form/original state after effect cleanup. An additional deferred-response test passed: begin A's load, move to B, load B successfully, then resolve A; B's fields remain. That guard addresses **late responses**, while R11-01 concerns **already stored state** surviving the route transition.

### Every event-update writer in `src/`

Searched both `updateEvent(...)` calls and direct Supabase table writes, including `.update`, `.upsert`, `.from`, RPC and fetch usage. The only direct event UPDATE query is inside the shared API helper:

| Writer | Expectation |
| --- | --- |
| `src/pages/admin/EventFormPage.tsx:85` | `original.updated_at` |
| `src/pages/admin/EventsPage.tsx:154` — Archive / Restore | Displayed `event.status` |
| `src/pages/admin/EventDetailPage.tsx:71` — Publish | Displayed `event.status` |
| `src/lib/api.ts:137–138` — sole direct event UPDATE | Runtime-checked version or status predicate, plus ID |

No other `supabase.from('events').update(...)`, event upsert, or separate event-update transport was found in `src/`. Event creation and deletion use their separate API methods. The routing finding still supplies a condition; its problem is record identity, not a missing predicate.

### API contract and version handling

The expectation is mandatory in TypeScript. `{}`, an empty `updatedAt`, an undefined `updatedAt`, and an undefined `status` all produce `missing_version` before the query builder is reached. A nonempty timestamp or status selects the corresponding filter. A zero-row response consistently becomes `edit_conflict`.

Version strings are still passed through unchanged, preserving PostgreSQL microseconds and offset notation; the edit form does not convert `original.updated_at` into a JavaScript Date. Status conditions intentionally detect status changes rather than every intervening metadata update or a status that changes away and back. The helper is optimistic application coordination, not a prohibition on direct owner/database writes.

A plain JavaScript call omitting the entire expectation object would currently throw a TypeError at the `in` operator, rather than the named `missing_version` error. It still starts no query, and no current typed caller omits the object. This is an error-contract refinement, not another ID-only write path or a blocking finding.

## Verification and sensitivity

| Check | Result |
| --- | --- |
| Typecheck | Passed |
| Lint | Passed |
| Unit | 122/122 passed, 25 files |
| Existing local integration suites | 138/138 passed, 15 files |
| Additional route-response fixtures | One passed; one intentionally failed for R11-01 |

Browser suites were not independently rerun in this frontend-focused round; the supplied 9/9 result is the author's result, not an independent result claimed here. No additional server or Docker infrastructure was introduced. Extra probes were ignored local artifacts, not application edits or committed tests.

**L sensitivity:** Copied the current tests into an isolated tree and restored the literal `c10d678` API and EventFormPage implementations. The new runtime-refusal test and both new page tests failed; the three existing API expectation/conflict tests and the non-executing type-test wrapper passed: **3 failed / 4 passed**. The page tests fail at the missing new error/retry UI; they do not independently execute their later Save assertions on the old page. The prior review already established the old load-error save.

The type-level check was also run against the historical API: TypeScript reports the two `@ts-expect-error` directives as unused because the old API permitted missing/empty expectations. Current typecheck accepts those directives because those calls are now actual type errors. The runtime wrapper test merely defines the bad calls; it is the compiler check that establishes this contract.

The API's multi-case runtime test stops at the first historically accepted empty expectation. All four current empty/member-undefined cases execute and pass on the current API. No missing-file or missing-method failure was counted as historical sensitivity. No database/Edge counterfactual changes were made.

## Practical readiness

The evidence now points to a stable core registration/admission flow, with recent work concentrated on uncommon editor and presentation cases rather than failures of ordinary admission. No High or Critical finding was established in this scoped review. That is not a new whole-system certification or a verification of the live deployment.

**Recommendation:** suitable for a controlled pilot/private event, with an organizer supervising operations. Close R11-01 before calling the administration workflow finished, and run one real-device rehearsal of registration, reopening a pass and scanning at the venue. This remaining correction is small but real; it is worth fixing rather than chasing an abstract zero-finding score. Broader public/high-volume use still needs the previously documented operational/abuse assumptions to be accepted, not silently treated as resolved by these frontend reviews.
