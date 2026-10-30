# PassSystem verification review 20

Reviewed **0b415b6..830ad38**, including **dcf0421** (phone tab row), **17e12d5** (R19 fixes), and the deployment record, on `claude/passsystem-implementation-h1i74q` ([PR #1](https://github.com/aleksacavic/PassSystem/pull/1)). **Both R19 findings are fixed. No new actionable finding or deployment blocker established in this scope.**

Only this report is committed. Application source, tracked tests, migrations and Edge Functions were not changed. No production service or production secrets were accessed. No Expo, React Native, separate server or Docker infrastructure was introduced or changed. The repository records frontend `17e12d5`, deployment `dpl_FdEKsaFxX79yrvd5Qa9c4BJzt95G`; live deployment status was not independently queried.

## R19 findings - fixed? yes / no / partly

| Finding | Fixed? | Evidence |
| --- | --- | --- |
| R19-01 — a newer error does not fence older completions | **yes** | An accepted error now advances the same applied sequence as success. The submitted newer-failure → older-success test preserves the error and leaves data null. An extra newer-failure → older-failure probe also preserves the newer error. Different-query and successful-response ordering controls remain covered by the passing unit suite. |
| R19-02 — an open menu leaves the viewport after resizing | **yes** | The open-menu effect subscribes to window resize and closes it; cleanup removes the listener. The original two-column 844px → one-column 390px browser schedule now closes the menu in both paired LTR/RTL modes. Reopening recalculates its side. Escape also restores focus to the trigger, verified in unit tests and the real-component browser probe. |

## Tab-row assessment

The browser probe used **markup captured from the actual EventDetailPage through its real router**, current compiled CSS, self-hosted fonts, and the same 16px horizontal main-content padding. It measured both English/LTR and Arabic/RTL direction states. This is a focused offline layout check, not a live application or production session.

| Viewport | Available row width | Row scroll width | Labels / layout |
| --- | --- | --- | --- |
| 320px | 288px | 288px | Overview, Registrations and Staff are single-line; Scan activity wraps to two lines. |
| 360px | 328px | 328px | All four labels fit on one line. |
| 390px | 358px | 358px | All four labels fit on one line. |
| 412px | 380px | 380px | All four labels fit on one line. |
| 640px (`sm`) | 608px | 608px | Natural-width pills, single-line labels. |
| 768px | 736px | 736px | Natural-width pills, single-line labels. |
| 1024px | 992px | 992px | Natural-width pills, single-line labels. |

Results were the same in LTR and RTL: **no row or document horizontal overflow** at these widths. RTL mirrors the visual order; labels remain the existing English admin copy rather than introducing Arabic translations.

All buttons measured **36px high**, including the two-line label at 320px; inspected screenshots show no clipped text. Phone text is 13px, switching to 14px from `sm`. The measured absence of scrolling comes from the contents fitting, not merely hiding a scrollbar: `scrollWidth == clientWidth` throughout. Computed scrollbar width is `none`; `overflow-x-auto` remains a fallback for other conditions.

The diff changes tab sizing/classes only. Selection handlers, `?tab=attendees` / `?tab=activity` keys, event-owned remounting and the selected-state logic are unchanged. Active styling changes colors, not the measured padding/font sizing.

## New findings

**None.** No new concrete defect worth holding deployment or requesting another polish pass was established. This does not mean every previously documented operational limitation has been removed; this review is restricted to the current frontend changes.

## Focused validation

Testing followed the owner's request for minimal local validation. **No local integration/E2E suite, production service check or infrastructure setup was run.**

| Check | Result |
| --- | --- |
| Full local unit/component suite | **178/178 passed**, 33 files |
| Extra older-error completion check | **1 passed**; newer error survives an older rejection |
| Real page/router markup capture | **1 passed**, used for the requested layout measurements |
| Tab layout | Chromium at seven widths in LTR and RTL; 320px screenshots inspected; current CSS/fonts compiled into an ignored offline fixture |
| Menu interaction | Actual React Menu: resize closes it and Escape restores trigger focus in LTR and RTL |
| Typecheck / lint / integration / full workflow E2E | Not rerun locally; supplied green CI on `17e12d5` remains author-reported evidence |

The small browser fixture was compiled solely for these layout/interaction checks and loaded without a server. It did not run the full application build/test pipeline. Fixtures are ignored under `tests/.artifacts/review20/`.

Sensitivity restored literal **0b415b6** Menu and usePagedList implementations in an ignored historical snapshot, retaining current targeted tests. Result: **3 failed / 3 passed**. Newer-error fencing, resize closure and Escape focus restoration failed on their intended behavioral assertions; the three prior loader controls passed. No absent-module/import failure was counted. Historical fixtures are under `/tmp/passsystem-review20-before`; checkout application files were never replaced.

## Readiness

**These changes are ready to deploy/use for the intended supervised event. No further minor-polish review is needed to justify that use.** Both reported fixes work, and the phone tab row fits the requested sizes.

Complete the previously requested real-device/venue rehearsal before relying on it at the door. For a broader unsupervised public rollout, the earlier operational/load/abuse and publishing decisions still apply; this round adds no new gate. Prioritize that operational evidence over continuing to chase cosmetic zeros. This review did not independently certify the live deployment or perform the rehearsal.
