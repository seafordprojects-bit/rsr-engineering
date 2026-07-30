# Spec — AWOL detector: merge preconditions and eight defects

**Target path in repo:** `docs/superpowers/specs/2026-07-30-awol-detector-preconditions-and-defects.md`
**Revision:** 2 (2026-07-30, evening). Revision 1 of this filename is superseded — its §3.1 claim that
deployed `main` is safe is **false**, and its §2.2 misclassifies RSR 0014.
**Also supersedes:** `docs/superpowers/specs/awol-detector-start-date-and-event-integrity.md` — its §5
states the inverse of the truth and must not be implemented.
**Blocks:** merge of `awol-suspension-flow` to `main`; AWOL reinstate dashboard build

---

## 1. The finding in one paragraph

The AWOL detector opened a case against a worker whose absence the owner had personally
authorized. The resulting lockout stopped him punching when he returned, which generated
further absences, which the detector read as escalation. He has worked four days with no
attendance record and no pay data. **This happened on deployed `main`, which a previous
revision of this spec described as safe.** Measured against live data, the detector would flag
nine active regular workers today. **Exactly one of the nine — RSR 0015 — is a genuine
unexcused absence.** The other eight are artefacts of yards without hardware, staff who do not
punch, paperwork awaiting the owner's signature, permissions given by word of mouth, and a
lockout the detector caused itself. One correct flag in nine.

---

## 2. Evidence

Measured in project `wpmcbjrisuyjvobvzaus` on 2026-07-30 unless marked otherwise.

### 2.1 Active suspensions

`select count(*) from public.employee_suspensions where active is true;` → **0**

One sweep-created row on `RSR 0000` existed earlier and was cleared during teardown. An
implementation report claiming three active rows was working from session context, not the
database. Do not carry that figure forward.

### 2.2 The nine workers the sweep would flag

Active, non-pakyaw, no attendance 07/28–07/30:

| Code | Name | Listed site | Actual | Why flagged | Genuine AWOL? |
|---|---|---|---|---|---|
| RSR 0011 | George Galo | Mandaue | Mandaue | no kiosk at yard | no |
| RSR 0018 | Pablo Arobo | Mandaue | Mandaue | no kiosk at yard | no |
| RSR 0023 | Ritchie Lawan | Mandaue | Mandaue | no kiosk at yard | no |
| RSR 0034 | Chrismark Ybas | Mandaue | Mandaue | no kiosk at yard | no |
| RSR 0014 | Art Clenthon Tañola | **Mandaue (stale)** | **Carmen** | absence verbally approved by owner | **no** |
| RSR 0025 | Jamaica L. Batucan | Carmen | Carmen | office-based, never punches | no |
| RSR 0005 | Alvin H. Operio | Carmen | Carmen | leave filed, awaiting approval | no |
| RSR 0035 | Allan Manos | Carmen | Carmen | absence verbally approved, then locked out | **no** |
| RSR 0015 | Niño Nieto Panut | Carmen | Carmen | genuinely absent, unexcused | **yes** |

`RSR 0023` is a named issuer for tool/material. `RSR 0025` is the sole authorized AWOL clerk —
the only person who can perform the letter-received step of the reinstate flow this branch is
building.

### 2.3 Site capture

```
07/28  Carmen  27
07/29  Carmen  27
07/30  Carmen  29
```

Mandaue produces no rows on any date. Its kiosk has never been commissioned — the enclosure is
still to be fabricated. Carmen's kiosk is healthy, so Carmen absences carry real signal.

### 2.4 Attendance provenance

`RSR 0025` rows from 07/18–07/24 all read exactly `08:00 AM` / `05:00 PM`. Her only row with
seconds and an irregular minute (`06/26`, `11:33:08 AM`) is a genuine punch made while testing
the kiosk. The uniform rows were entered by hand. `RSR 0015` and `RSR 0035` show the same mix.
**Captured punches and maintained rows are currently indistinguishable.**

### 2.5 Separations pending

`RSR 0017` Gaviola Salvador and `RSR 0020` John Michael Armenion left the company, verified as
not returning. Both still carry `separated_at = null` with no attendance row ever. Excluded
from the nine above, but an active employee with no attendance is exactly what the sweep
escalates.

---

## 3. Defect C — the lockout cascade (BLOCKING, outranks everything)

### 3.1 What actually happened to Allan Manos

1. He was absent on a day the owner had verbally approved. Nothing recorded the approval.
2. The sweep read unexplained absence and opened a case.
3. The case became a kiosk lockout.
4. He returned to work Monday 07/27 and **could not punch**.
5. Every subsequent working day recorded as a further absence.
6. There was no working reinstate path, so the state persisted.

The failure is self-reinforcing: a false positive produces a lockout, the lockout manufactures
the very evidence that appears to justify it, and nothing in the loop requires a human. Four
days of work exist with no record.

### 3.2 Deployed `main` is not safe — revision 1 was wrong

Revision 1 reasoned that `main` carries no `employee_suspensions` reader, that its
`suspendedEmployees` comes from localStorage, and that the 07-26 hotfix wipes it on every
sweep — therefore a case could not gate a tablet.

**Allan was blocked after that hotfix.** The reasoning fails against observed behaviour.

**This is the first thing to investigate and it is not optional.** Either the hotfix is not
reaching the Carmen tablet — plausible, given the unresolved service worker caching issue and
that the tablet's version stamp has never been visually confirmed — or something re-adds the
lockout after the wipe. Until this is understood, the same thing can happen to another worker
tomorrow, with no branch deployed at all.

Do not clear the tablet's site data before checking it: it may be holding unsynced punches,
possibly Allan's.

### 3.3 What is true about the code

Confirmed by reading, not inferred:

- `employee_suspensions.active` is what the kiosk punch path checks. It **gates entry**.
- `employees.is_suspended` is written at `kiosk/index.html:5495` in an upsert payload, and read
  only into a personnel-list display (`coordinator.js:17`) and a payroll display flag
  (`payroll/index.html:705`). **Nothing enforces it.**
- Branch `awol-suspension-flow` adds a DB reader **and** a PIN-entry gate, so every active row
  becomes a live block on deploy — widening a hole that is already open.

### 3.4 Required

- **The branch does not merge until a sweep-created case cannot, by any path, block a worker at
  the kiosk.** Hard precondition on the whole branch.
- Case-open and worker-barred are separate fields with separate writers. Only a PIN-gated owner
  action sets worker-barred.
- **A reinstate path must exist and be demonstrated before any lockout mechanism ships.** A
  system that can bar a man and cannot un-bar him is not shippable. This is what turned one bad
  flag into four lost days.
- A test that fails if a sweep-written row can reach the punch gate.

### 3.5 Naming

`employee_suspensions.active` means "this case is open" but is consumed as "this worker is
barred." One boolean, two meanings, nobody's intent. **Rename as part of this change** — the
ambiguity caused the defect and has already misled two readers of this codebase, including the
author of revision 1.

---

## 4. Defect G — verbally approved absence leaves no artifact

Two of the nine (Allan, Art) were absent with the owner's spoken permission. The system had
nothing to read, so a correctly-functioning detector would have flagged both identically.

**Legal exposure:** AWOL under DO 147-15 means absence *without* leave. If the owner authorized
it, no case should exist — but the record shows unexplained absence, and "I told him verbally"
is a weak position if contested. An NTE issued on these facts would not survive scrutiny.

**Required:** a fast path for recording a verbal notice on the day it is given — logged by
Jamaica or the yard coordinator, capturing who reported, who authorized, and which dates. It
must be faster than filing formal leave, or it will not be used and this recurs.

This is not detector tuning. No threshold change fixes an absence the database cannot see.

---

## 5. Defect H — `home_site` is stale and cannot be trusted as a gate

`RSR 0014` is listed `home_site = Mandaue` and works at Carmen.

This breaks Defect D's fix directly: a site gate keyed on `home_site` would have exempted a
Carmen worker from detection while his yard's kiosk was working normally. The gate would be
both wrong and invisible.

**Required:** establish how many employee rows carry a stale `home_site` before building
anything that keys off it. If the field is unreliable in general, the site gate must key off
something else — the site that actually captured the worker's recent punches, or explicit
per-worker configuration. Raise the options; do not pick silently.

---

## 6. Defect D — no site gate for yards without capture

A yard with no operational kiosk cannot produce absence evidence. Mandaue reads as four men
absent every working day, indefinitely.

**Required:** detection skipped for any site with no operational capture device. Site status
must be explicit configuration a person sets, never inferred from row counts — a quiet yard and
a broken yard look identical from the data, and inferring would recreate this bug the first time
Carmen has a slow week. Skipped sites surface in the kiosk health banner.

Subject to Defect H: the gate needs a trustworthy notion of where a worker actually works.

### Implemented 2026-07-30, and two consequences to keep in mind

`awol_effective_site(code)` resolves to **the site of the worker's most recent real punch**, falling
back to `home_site` only for a worker who has never punched anywhere. It is NOT keyed on
`home_site`, deliberately: 11 of 43 active rows disagreed with their punch site (measured 07-30,
before the RSR 0014 correction), 10 of them men posted to Mandaue who clock in at Carmen because
Mandaue has no kiosk. A gate keyed on `home_site` would have exempted ten men who punch at Carmen
every day, and looked like it was working.

**Consequence 1 — a single stray punch moves a man's detection site.** Found live during the STEP 7
probes: one owner test punch on the Mandaue tablet became RSR 0000's most recent punch, so
`awol_effective_site` returned Mandaue and the site gate exempted him. Correct behaviour by the
rule as written, surprising in effect, and **it would have been invisible without
`awol_skip_reason()`** — the skip list is what surfaced it. Anyone changing the resolution rule
later should know it is last-punch-wins, not most-frequent or most-recent-N.

**Consequence 2 — a site that captures punches but is not configured skips detection.** Fail-open by
design (`not` outside the `coalesce`), so nobody is harmed, but it means a newly commissioned yard
switches detection OFF for everyone there until someone adds it to `site_capture_status`. Standing
check for that:

```sql
-- Workers whose most recent punch is at a site not in site_capture_status. EXPECT 0.
with last_punch as (
  select distinct on (upper(regexp_replace(employee_code,'[^A-Za-z0-9]','','g')))
         upper(regexp_replace(employee_code,'[^A-Za-z0-9]','','g')) as code_norm,
         site, public.leave_try_date(date) as d
    from public.attendance_records
   where timein is not null and timein <> '(auto-skipped)'
     and site is not null and public.leave_try_date(date) is not null
   order by 1, public.leave_try_date(date) desc)
select e.code, e.name, l.site, l.d
  from public.employees e join last_punch l on l.code_norm = e.code_norm
 where e.separated_at is null
   and not exists (select 1 from public.site_capture_status s where s.site = l.site)
 order by e.code;
```

Measured 07-30: 0 rows. `TEST-SITE` holds 17 rows (RSR 0001, 0002, 0003, all 8–13 June) but none of
the three has it as their latest punch, so nobody is currently affected.

**Follow-up, owner-requested 2026-07-30, not built:** flipping `has_kiosk` currently needs SQL editor
access, because `insert/update/delete` on `site_capture_status` is revoked from `anon` — a client
that could set `has_kiosk = false` could switch off detection for a whole yard. It wants a PIN-gated
RPC (`set_site_capture`) in the same shape as `set_non_punching`, so commissioning the Mandaue kiosk
does not require a developer. Deliberately deferred, not forgotten.

**This also breaks Defect A's fix alone.** Flooring the scan at `started_on` does nothing for
George Galo, whose start date is 2023-10-27 and whose attendance is empty — he would be flagged
with roughly a thousand consecutive absences. A and D must both land.

---

## 7. Defect E — pending leave triggers detection instead of suspending it

Alvin H. Operio (RSR 0005) filed leave through Jamaica. It is unapproved because the owner has
been occupied with this AWOL work. He is currently flagged.

The reason string says "without approved leave," but that is prose. Determine from the code
which is happening: if any leave row suppresses detection, filing makes a worker invisible and
the control is worthless; if only approved leave suppresses it, a worker is penalised for the
owner not processing his paperwork. **Both are wrong; the second carries legal exposure.**

**Required:** a pending request suspends detection for the dates it covers. Pending requests
appear in the admin dashboard with an age indicator so they cannot sit indefinitely.

---

## 8. Defect F — no category for staff who do not punch

Jamaica L. Batucan is office-based and does not use the kiosk; her rows are maintained by hand.
No tuning makes detection meaningful for her, and she is the one person who cannot afford to be
locked out — she performs the letter-received step.

**Required:** an explicit non-punching category, exempt at both app and database layers,
following the pattern already proven for pakyaw/PEM. Setting it is a PIN-gated admin action that
writes an audit row.

Adjacent, to be decided rather than assumed: hand-entered rows are indistinguishable from
captured punches (§2.4). At minimum they should be marked. Whether that is a column, an audit
reference or something else is a design question with payroll implications — raise options.

---

## 9. Defect A — null `started_on` produces a phantom absence run

Confirmed **not** live: all nine flagged workers have `started_on` populated. A new-hire trap,
not a present emergency.

The scan window must never begin before the worker's start date. Where `started_on` is null,
skip detection and surface the worker in the health banner as a data-quality warning. Do **not**
fall back to `created_at` — that is when the row was typed in, not when the man started work.
Fail open: uncertainty resolves in the worker's favour, visibly.

---

## 10. Defect B — suspension written with no `awol_events` row

The sweep created a suspension for `RSR 0000`, populated its Telegram message id, and wrote no
event row. `ZZ WALK3`, from the same run, did receive one (id 19, `suspended`).

`awol_events` is the audit trail the twin-notice defensibility rests on. A case with no event
behind it is a disciplinary action with no provenance.

**Investigate before patching.** Candidates: the two writes are not in one transaction and the
event insert failed without aborting the suspension; events are written only on certain
transitions and this path misses the insert; a guard trigger rejected it silently (note the
`job_close` pattern — a BEFORE trigger returning NULL blocks the write, affects zero rows,
raises nothing); or an exemption branch applies to one insert and not the other. **Report the
cause before writing the fix.**

**Required:** suspension and originating event written atomically. No path creates or mutates a
case without writing its event.

---

## 11. Order of work

1. **§3.2 — how Allan was blocked on deployed `main`.** Diagnosis only, no code. Nothing else
   is safe to reason about until this is known.
2. **Defect C** — separation of case-open from worker-barred, plus a working reinstate path.
3. **Defects G, H, D, E, F** — the false-positive sources. Together they account for eight of
   nine.
4. **Defect B** — audit integrity, before any real case is opened against a real worker.
5. **Defect A** — new-hire trap, no live instance.

---

## 12. Out of scope

- The 3-consecutive-absence threshold and Sunday exclusion. Both verified correct (the evidence
  correctly omitted 07/26 and 07/19).
- PEM/pakyaw exemption via `employment_type` / `type_effective_from`. Working, leave alone.
- The reinstate dashboard as a feature. Note that a minimal reinstate path is **in** scope per
  §3.4 — the dashboard build is not.
- Julius / PEM 0001 `type_effective_from` (STEP 7b). Awaiting his real start date.
- **Plaintext PINs in `employees.pin`** — every worker's kiosk PIN is readable to anyone with
  table read access, and PIN-gated actions are what the paper trail rests on. Own spec, own
  walkthrough. Do not fold in; do not lose.
- **`punch_date` DATE migration** — `max(date)` over the TEXT column sorts lexically, which is
  why last-punch dates in §2.2 were unreliable during diagnosis.

---

## 13. Acceptance criteria

Each demonstrated with pasted output, per "measured, not assumed."

**C0.** The mechanism that blocked Allan on deployed `main` is identified and stated plainly.
**C1.** A sweep-created case cannot block a worker at the kiosk by any path. Show the failing
test.
**C2.** Case-open and worker-barred are separate fields; only a PIN-gated owner action writes
worker-barred. Grep and show no sweep path touches it.
**C3.** A barred worker can be reinstated and punch again, demonstrated end to end on localhost.
**G1.** A verbal notice recorded on the day suppresses detection for those dates, and the record
shows who reported and who authorized.
**H1.** The count of employee rows with stale `home_site` is measured and reported before the
site gate is built.
**D1.** With Mandaue marked as having no operational kiosk, none of its workers are flagged, and
the health banner names the exclusion.
**E1.** A worker with a pending leave request covering the absent dates is not flagged; the
request shows in the admin dashboard with its age.
**F1.** A non-punching worker is exempt at both layers. Verify the DB layer with a direct insert
attempt, as was done for the pakyaw guard.
**A1.** A worker with `started_on = null` is not flagged, appears in the health banner, and can
still punch.
**A2.** Sunday exclusion still holds after all changes.
**B1.** A sweep-created case has exactly one matching `awol_events` row, same transaction. Probe
both tables.
**B2.** Forced-failure test: with the event insert made to fail, no suspension row survives and
the failure is visible.
**Z1 — scoped to C + D + F (owner, 2026-07-30).** G, E and H come after, so their false positives
are still expected. Re-run the §2.2 query with C, D and F in and **expect exactly three flagged:**

| Code | Name | Why still flagged | Closed by |
|---|---|---|---|
| RSR 0015 | Niño Nieto Panut | genuine unexcused absence — the control case | nothing; must stay |
| RSR 0005 | Alvin H. Operio | pending leave not yet approved | Defect E |
| RSR 0014 | Art Clenthon Tañola | absence agreed verbally, no artifact | Defect G |

**Any Mandaue worker appearing means D is incomplete. Jamaica appearing means F is incomplete.**

**RSR 0015 missing means it has gone too far** and is now suppressing real absences. Every defect
in this spec pushes toward flagging less, and a detector that flags nobody satisfies every other
criterion here — RSR 0015 is the only thing standing between "fixed" and "switched off".

**RSR 0014 must NOT be suppressed by D.** He is listed `home_site = Mandaue` and works at Carmen.
A site gate keyed on `home_site` would exempt him and quietly pass a test it should fail. The gate
therefore keys on `awol_effective_site()` — the site that captured his most recent real punch,
falling back to `home_site` only for a worker who has never punched anywhere. Verified in
`awol-defect-cdf.sql` STEP 7: `awol_effective_site('RSR 0014')` must return `Carmen` and
`awol_skip_detection('RSR 0014')` must return **false**.

Final Z1 (one worker, RSR 0015 only) applies once G, E and H land — **and that, not the three-flag
checkpoint, is the merge criterion.**

### Only RSR 0015 deserves a flag — so C alone is not a merge gate

Owner, 2026-07-30, reviewing the STEP 11 skip list. Of the three:

- **RSR 0015** — genuinely absent, unexcused. Correct, and must keep being flagged.
- **RSR 0005** — leave **filed, awaiting the owner's approval**. Did nothing wrong. Needs Defect E.
- **RSR 0014** — absent with the owner's **verbal permission**. Did nothing wrong. Needs Defect G.

`awol_skip_detection` returns `false` for all three and is **right** to: "skip" means *has a
legitimate exemption category*, and neither RSR 0005 nor RSR 0014 has one. The fault is upstream —
**the system has nothing to read.** A filed-but-unapproved leave and a spoken permission are both
invisible to it. No detector tuning fixes an absence the database cannot see.

So with C, D and F alone the detector would open cases, post to the AWOL Telegram group, and in time
auto-draft non-submission letters **against two men who did nothing wrong.** C makes that harmless at
the tablet — nobody is barred, nobody loses pay — but it does not make it *stop*. The disciplinary
noise, and the standing of any NTE issued on those facts, are untouched by C.

**The merge gate is therefore C and E and G, not C alone.** A detector that is safe but wrong still
puts a notice in an innocent man's file, and "the alert was harmless" is no defence if one is ever
contested. D and F removed seven of the nine false positives; E and G remove the last two.

The three-flag result is a **checkpoint** proving C+D+F landed correctly. It is not permission to
merge.

---

## 13a. STATE AS OF 2026-07-30, END OF SESSION — read this first tomorrow

Migration file: **`awol-defect-cdf.sql`** at the repo root. Steps are numbered in that file.
Everything below was run by the owner in the Supabase SQL editor against **production**
(`wpmcbjrisuyjvobvzaus`) and verified with a probe. Nothing was assumed.

### Applied and verified — STEPs 1 to 7

| STEP | What | Verified by |
|---|---|---|
| 1 | `employee_suspensions.barred_at` / `barred_by` added | both columns `timestamptz`/`text`, nullable |
| 2 | `employee_suspensions_bar_guard_biu` trigger; anon UPDATE narrowed | trigger count 1; anon holds UPDATE on exactly `awol_group_chat`, `awol_group_msg_id` — neither `barred_at` nor `barred_by` |
| 3 | `is_non_punching` + audit columns; `employees_flag_guard_biu`; `set_awol_clerk`; `set_non_punching` (5-arg) | guard refused `is_awol_clerk` **and** `is_non_punching` on RSR 0000 with `42501` |
| 4 | `site_capture_status` (Carmen true / Mandaue false); `awol_effective_site` | Carmen true · Mandaue false; Art → Carmen, Galo → Mandaue, Niño → Carmen |
| 5 | `awol_is_exempt`, `awol_skip_detection`, `awol_skip_reason`; suspension guard extended to non-punching | pem true · Niño false/false/null |
| 6 | `awol_set_barred` (bar + the minimal reinstate path, §3.4) | created; **probes not yet run** — they are in STEP 9 and need the passcode |
| 7 | read-only verification of D and F | skip list = 9: four Mandaue men + five pakyaw |

### STEP 8, 9, 10 — applied and verified 2026-07-30, later the same session

| STEP | What | Verified by |
|---|---|---|
| 8 | Jamaica marked non-punching | `ok true`; RSR 0025 `is_non_punching = true`, `set_by Raffy`, timestamp written; **one `awol_events` row (`non_punching_set`, actor Raffy) in the same transaction**; skip list now **10** |
| 9 | **Defect C demonstrated, not merely applied** | see below |
| 10 | final verify | `2 · 1 · 5 · 2 · 1 · 1 · 0` |

**STEP 9 — the C1 acceptance criterion is met:**

- hand-typed `UPDATE` to `barred_at` → **ERROR 42501, refused**
- `case_open` true with `barred_at` NULL → **the separation holds**
- `awol_set_barred` bar → `ok true`, `now_barred true`
- `awol_set_barred` unbar → `ok true`, `barred_at` and `barred_by` both back to NULL — **the minimal reinstate path of §3.4 works end to end**
- wrong passcode → `{"ok": false, "reason": "Not authorised"}`
- teardown → `0 · 0 · 0`

So a sweep-written row cannot reach the punch gate **at the database layer**. The client half is
still unwritten — see "the three items owed".

### Defect B reproduced in miniature, during the STEP 9 teardown

`ZZ BARTEST` finished with **2** `awol_events` rows, not 3. `barred` and `unbarred` were both
written; **the insert that opened the case wrote none.**

Precisely what this does and does not show:

- **It does show** there is no structural guarantee pairing a case with its originating event.
  Nothing at the database layer forces one, which is exactly what §10's "Required: suspension and
  originating event written atomically" asks for. The fix has a demonstrated need.
- **It does not yet explain the original divergence.** The probe used a raw `insert`, which no
  trigger watches, so writing no event is expected. Defect B's actual puzzle is why
  `awol_set_suspended` wrote an event for `ZZ WALK3` and none for `RSR 0000` **in the same sweep
  run**. That still needs the investigation §10 asks for — do not treat this as the diagnosis and
  skip straight to a patch.

### The passcode was never lost

`admin_verify_passcode` verified `true`. The credential was intact throughout, exactly as the
`updated_at` reasoning predicted: that column records when the hash was **written**, not when it was
last used, so a ten-day-old timestamp was never evidence of a problem. **The break-glass procedure
was not needed and was not run.** It stands as documentation for a real future lockout.

### STEP 8 is BLOCKED on the admin passcode

`set_non_punching` verifies via `admin_verify_passcode`, which is returning `false` for what the
owner is typing. State when the session ended: `kiosk_admin_credential` has 1 row,
`updated_at 2026-07-20 09:16 UTC`; `admin_verify_throttle` showed **3 fails, no lockout** — so
**7 attempts remain** before a 15-minute global lockout that takes both tablets' Admin panels with it.

**Do not brute-force it.** Two facts established while diagnosing:

- `updated_at` is when the hash was **written**, not when it was last used. `admin_verify_passcode`
  only reads the credential row and writes `admin_verify_throttle`. A ten-day-old timestamp is
  normal for a PIN in daily use and is **not** evidence the credential changed.
- A correct PIN **was** accepted on 2026-07-30: the dashboard AWOL card returns early at
  `if (ok !== true)` and the scenario-2 manual suspension got past it, and probe v2's seven
  `leave_decide` cases each verify the passcode inside the RPC. So the credential is intact — this is
  recall, not corruption.

If it cannot be recalled: **`docs/runbooks/kiosk-admin-passcode-reset.md`** (written 2026-07-30 —
there was no documented path before). It resets to a throwaway value in SQL and rotates to the real
PIN **through the dashboard**, because `admin_bootstrap_passcode` takes the PIN as a literal argument
and would otherwise leave it in Supabase query history. **It invalidates Admin on both tablets at
once** — do it when nobody needs the panel, and tell Jamaica and the yard coordinator immediately,
since she performs the letter-received step.

### Also verified tonight, worth not rediscovering

- **`home_site` disagrees with the punch site for 11 of 43 active workers** (10 of them posted to
  Mandaue but clocking in at Carmen). A site gate keyed on `home_site` would have exempted ten men
  who punch at Carmen daily. Defect D keys on `awol_effective_site` instead — see §6.
- **A single stray punch moves a worker's detection site** (last-punch-wins). Found live: one owner
  test punch on the Mandaue tablet exempted RSR 0000. Only `awol_skip_reason()` made it visible.
- **`TEST-SITE` holds 17 rows** — RSR 0001, 0002, 0003, all 8–13 June. None of the three has it as
  their most recent punch, so nobody is currently affected.
- **The kiosk employee sync cannot trip the new guards.** `kiosk/index.html:5268-5272` is
  select-then-update-or-insert, not an upsert, and its 13-column payload contains neither flag. So
  marking Jamaica non-punching in STEP 8 will not break Carmen.
- **`employees` has table-level UPDATE granted to anon**, covering all 24 columns including `pin` and
  `daily_rate`. Not fixed, deliberately — written up as
  `docs/superpowers/specs/2026-07-30-anon-grant-surface-on-employees.md`.
- **The `%s` in the guard's `raise` was corrected to `%`** (PostgreSQL uses bare `%`; the message
  read `is_non_punchings`). Cosmetic; behaviour was always correct.

### The three items owed

1. **`awol-defect-cdf.sql` STEPs 8, 9, 10** — 8 needs the passcode; 9 is the C1 proof that a
   sweep-written row cannot reach the punch gate, plus the bar/unbar round trip; 10 is the final
   verify.
2. **The client changes**, still unwritten and deliberately so — naming `barred_at` or
   `is_non_punching` in an explicit select before the migration is verified live is the `b64ed5c`
   mistake. Once STEP 10 passes: the kiosk gate repointed from `active` to `barred_at` at both sites
   (`:2058`, `:2868`); **the `:2058` ordering fix** so a reinstate works on the first attempt rather
   than the second; the sweep calling `awol_skip_detection()` with skips surfaced in the health
   banner; a Reinstate button on the dashboard AWOL card; and a smoke-test case that fails if a
   sweep-written row reaches the gate.
3. **Localhost walkthrough before anything is pushed.** Nothing in this work has been near `main`.

### Still not started, in §11 order

Defect C's client half, then **G, E, H**, then **B**, then **A**. Z1 for the C+D+F scope expects
**three** flagged — RSR 0015, RSR 0005, RSR 0014 — not one.

## 14. Test data hygiene

Use fresh ZZ-prefixed codes, never `RSR 0000`.

The 2026-07-30 teardown scoped deletes to fabricated ZZ codes, but the scenario also punched as
`RSR 0000`, whose sweep-created suspension survived and needed separate cleanup. **Every
identity a walkthrough writes as must be in the teardown's scope** — and every table it can
reach: `attendance_records`, `employee_suspensions`, `awol_events`, `leave_requests`.

Pattern: read-only recon, a guard that aborts on unexpected state, deletes ordered
children-before-parents, and a verify comparing a pre-captured list of real worker codes against
the post-teardown list. If the scenario posts to Telegram, capture `awol_group_msg_id` and delete
the message as part of teardown — message 6287 had to be pulled by hand.

---

## 15. Rollout

Worker-facing and discipline-adjacent. Full discipline, no exceptions:

1. Localhost walkthrough first. Raffy sees it on screen before anything is pushed.
2. Version stamp bumped, format `v2026-MM-DDa`.
3. Stamp verified by eye on live GitHub Pages after the push.
4. Fully Kiosk Start URLs updated with cache-buster on both tablets; stamp confirmed visually on
   each physical screen. **Given §3.2, this step is now load-bearing rather than routine** — an
   unverified deploy is how a worker stays locked out after the fix ships.
5. SQL proposed by Claude Code, run by Raffy in the Supabase SQL Editor against
   `wpmcbjrisuyjvobvzaus`, each step followed by a probe query.

The Allan correction (§16) **is** pay-adjacent and requires a before/after peso diff exact to the
centavo.

---

## 16. Operational items — Raffy, not Claude Code

- **Allan Manos (RSR 0035) has four days of unrecorded work: 07/27, 07/28, 07/29, 07/30.**
  Reconstruct his hours with the Carmen coordinator before memories blur, and correct the
  payroll. This is the most urgent item in this document and does not wait for any software fix.
- **Check whether Art Clenthon Tañola (RSR 0014) is also locked out.** His last punch reads
  07/18 and he works at Carmen. If he has been turned away, he needs the same reconstruction.
- **Niño Nieto Panut (RSR 0015) is a genuine unexcused absence** — confirmed by the owner, and
  the first real AWOL matter this system has surfaced. Handle through the proper twin-notice
  process on paper now, rather than waiting for the detector to be fixed. Absence dates are
  07/27, 07/28, 07/29 and 07/30 (07/26 was a Sunday), following his last punch on 07/25. The
  five-day explanation window runs from service of the NTE, not from the absence, so starting
  late only pushes the whole timeline back.
- **Correct `home_site` for RSR 0014** to Carmen.
- **Mark RSR 0017 and RSR 0020 separated**, via the lifecycle path in `employee-lifecycle.sql` if
  it provides one. `separated_at` should be the real last working day, not today.
- **Decide Alvin's leave request** (RSR 0005).
- **Clear any remaining lockout on Allan** so he can punch tomorrow morning — before, and
  independently of, any of the work above.
