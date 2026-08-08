# AWOL detection must not judge absence from a pruned local cache

Spec owner: Raffy · Drafted 2026-08-05 · Status: NOT IMPLEMENTED

---

## 1. What happened

Between `2026-08-04 23:59:55` and `2026-08-05 00:00:07` UTC — a twelve-second burst —
the detector wrote ten `detected` rows to `awol_events`, each reading
"Absent 10 consecutive days without approved leave":

RSR 0003, 0010, 0015, 0019, 0027, 0028, 0030, 0032, 0033, 0036.

All ten are false. Checked against `attendance_records` for the ten dates each case
names:

| code | name | days actually present (of 10) |
|---|---|---|
| RSR 0019 | Jasper Taub | 10 |
| RSR 0027 | Demetrio Cambaya | 10 |
| RSR 0030 | Rolan Medio | 10 |
| RSR 0033 | Junrey Ricaplaza | 10 |
| RSR 0028 | Rolphy Pahugot | 9 |
| RSR 0032 | Christian Jay Sencio | 8 |

Nobody was barred. `barred_at` was never set, no NTE was served, and every case
reads "NOT barred — he punches normally." The fail-open rule held. This is a
paper-trail problem, not a lockout.

## 2. Root cause

`collectAbsentDates()` (kiosk/index.html:2446) looks back **21 days**. It decides
whether each day was punched by reading `records[empCode+'_'+d]` — the kiosk's own
**local in-memory / localStorage map, pruned to 10 days**.

The lookback window is longer than the store it reads. Any punch older than the
prune horizon is invisible to the detector and is counted as an absence.

This is already on the record. The owner's correction at `awol_events.id=35`
(2026-08-04) states it directly: the same worker's run "was recorded as 6 days on
08/03/2026 and as 10 days on 08/04/2026 — it grew by four days overnight, as two
punch records aged out of local storage."

Today's batch is the same defect at full extent. The tablet's site data was cleared
via `reset.html` during the 08/04 evening remediation, so the local map was rebuilt
near-empty. The next sweep — at day rollover / boot — found almost no punch history
for anyone and hit the 10-day cap for ten workers at once.

`attendance_records` held every one of those punches the whole time. The database was
never wrong. Only the tablet's cache was.

## 3. Why the existing guard did not catch it

`hasRecentPunchHistory()` (kiosk/index.html:~2490) exists precisely for "a worker with
no punch at all in the last 30 days has no meaningful attendance history to judge an
absence chain against."

It reads **the same `records` map**. When the map holds only today, it finds today's
punch, returns `true`, and detection proceeds against a history that is not there.

**A guard that shares the defect it guards against cannot fire.** This is the same
failure shape as the Step F banner (a stale row asserting a current fact) and as
`unknown_type_count` (a column absent from an explicit select arriving `undefined`).

## 4. Required changes

### 4.1 Detection reads the server, not the cache

`collectAbsentDates()`, `isAbsentOnDate()` and `hasRecentPunchHistory()` must judge
"was this day punched" from `attendance_records` in Supabase, not from `records[...]`.

A worker's attendance history is a **server fact**. The tablet's local map is an
optimisation for the punch UI and must never be the authority for a disciplinary
finding.

Constraints on that read:

- **Never a range filter on `date` — and the normalising happens IN SQL, not on the client.**
  *(Amended 2026-08-05 by the owner. The draft said to enumerate every spelling client-side
  and use `.in()`, as `loadWeekApprovalState()` and the coordinator's `getOpenPending()`
  do. That is the right pattern for those two — they read one day, or one week, from a
  page that already knows which dates it wants. It is the wrong pattern here.)*

  `attendance_records.date` is TEXT carrying mixed spellings (`MM/DD/YYYY` and
  `YYYY-MM-DD`, the slash form not reliably zero-padded). A `gte`/`lte` compares those
  lexically and silently drops rows — that constraint stands and is absolute.

  The mechanism is the one already built in `284bf8d` / `awol-punch-history.sql`:
  the window filter runs on `leave_try_date(a.date)` **inside** `awol_punch_days()`, which
  normalises in SQL and returns `NULL` (never raises) for anything that does not parse.
  The client receives ISO `YYYY-MM-DD` strings and compares through `awolISO()` only.

  Why this way rather than client-side enumeration:

  - **Scale.** The lookback is 31 days across the whole roster. Enumerating five spellings
    per day is ~155 values in one `.in()`, rebuilt on every sweep, on the boot path of a
    tablet that must stay responsive for punching. `awol_punch_days()` is one call
    returning one row per worker.
  - **Enumeration is a guess; normalisation is not.** A spelling nobody anticipated is
    absent from an enumerated list and reads as *"never punched"* — which invents an
    absence, the exact defect this spec exists to remove. `leave_try_date()` parses
    whatever is stored and yields `NULL` only for genuinely unparseable text.
  - **One authority.** `awol_effective_site()` already depends on `leave_try_date()`.
    A second, client-side notion of "which rows belong to this day" would be a second
    definition to drift.

  The `.in()` enumeration pattern stays correct where it is already used; it is simply
  not what this path uses.
- **Normalise the employee code on both sides.** Use the strict normaliser
  `upper(regexp_replace(code,'[^A-Za-z0-9]','','g'))` / client `codeNorm`, matching
  `employees.code_norm` and the `attendance_time_edit_one_pending` index. The current
  map lookup uses **raw** `empCode` while `isAbsentOnDate` calls `normCode()` for
  leave matching — that inconsistency is a live latent bug even after this fix.
- **Keep the `'(auto-skipped)'` exclusion** exactly as it is today, on every path.

### 4.2 Fail open on insufficient data — loudly

If the server read fails, returns empty, or covers fewer days than the lookback
window requires, detection **must not run**. It must not fall back to the local map.

On skip it must surface a visible notice, in the past tense, naming what was skipped —
the same shape as the existing skipped-detection banner. A silent skip is not
acceptable; a silent skip is how this went unnoticed for two days.

Never suspending is the safe direction. Judging on partial data is not.

### 4.3 The never-punched guard becomes independent

`hasRecentPunchHistory()` must query the server on its own, not share the detector's
data. Its purpose is to be a second opinion; a second opinion drawn from the same
source is not one.

The Mandaue go-live case it protects (workers with zero punches on file, tracked on
paper) still holds and must keep working.

### 4.4 Voided cases must not silently re-open

`awol_events.id=36` records that "detection re-opens a voided case on every run,
including at tablet boot." That is why voiding the ten cases today would be wasted
work.

A case the owner has voided must stay voided unless there is **new** absence after the
void timestamp. Re-detection of the same date range must not resurrect it.

## 5. Out of scope

- Widening the local prune horizon from 10 days to 21. That moves the cliff; it does
  not remove it. The store is not the authority.
- PEM / pakyaw exemption, Sunday transparency, the 3-day NTE threshold, the twin-notice
  workflow, manual suspension. All unchanged.
- Any change to `barred_at` behaviour. Detection still never bars.

## 6. Verification

Before this is considered done:

1. **Reproduce the failure on the current build.** Clear site data on a test kiosk
   profile, load it, run detection, and confirm false positives appear. A fix for a
   defect that cannot be reproduced is not verified.
2. Repeat on the fixed build. Expect **zero** detections for workers with punches in
   `attendance_records`, from an empty local cache.
3. Force the server read to fail (offline, or a bad table name). Confirm detection
   **skips** and the notice renders in the past tense. Confirm no case is written.
4. Confirm a worker with a genuine 3-day absence is still detected correctly.
5. Confirm PEM codes are still exempt at both layers.
6. Void a case, re-run detection, confirm it does not re-open.

## 7. Clearing the ten false cases

Only after the fix is live and verified — otherwise the next sweep recreates them.

Follow the pattern the owner established at `awol_events.id=35` and `id=36`: **correct
by addition, never by deletion.** Write a `correction` row per affected worker (or one
covering all ten, naming each) stating the finding, the cause, and that no NTE was
issued or served and `barred_at` was never set. Then void.

The original `detected` rows are retained unaltered.

---

## Appendix — evidence

- `awol_events` ids 41–50: the ten detections, 2026-08-04 23:59:55 → 2026-08-05 00:00:07.
- `awol_events` id 35: owner's correction naming the pruning cause, 2026-08-04.
- `awol_events` id 36: owner's addendum naming the re-open-on-boot defect.
- `kiosk/index.html:2443` — "Consecutive absent WORKING-day run, most-recent-first
  (MM/DD/YYYY keys)."
- `kiosk/index.html:2446` — `collectAbsentDates`, 21-day loop over `records[...]`.
- `kiosk/index.html:2423` — `isAbsentOnDate`, same map.
- Two prior BUG FIX comments in this family, both 2026-07-26, at lines 1376 and 2315.
