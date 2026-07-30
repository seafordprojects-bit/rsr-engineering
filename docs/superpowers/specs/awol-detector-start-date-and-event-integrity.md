# Spec — AWOL detector: start-date floor and event-row integrity

**Target path in repo:** `docs/superpowers/specs/awol-detector-start-date-and-event-integrity.md`
**Raised:** 2026-07-30, from the employment-type walkthrough teardown
**Status:** ready to implement
**Blocks:** AWOL reinstate dashboard build (do not start that until both defects here are closed)

---

## 1. Why this exists

The employment-type walkthrough on 2026-07-30 was torn down cleanly, but the teardown verify
turned up one live suspension that nobody created by hand. Investigating it surfaced two
separate defects in the boot sweep. Both are reproducible from data still visible in the
database. Neither was caused by the walkthrough — the walkthrough only made them visible.

Both defects are in AWOL detection, which is why they come before the reinstate dashboard.
There is no sense wiring a two-step reinstate flow on top of a detector that can open cases it
should never have opened and log them without an audit row.

---

## 2. Evidence

Captured 2026-07-30. This is measured output, not reconstruction.

### 2.1 The suspension the sweep created

`employee_suspensions`, single active row at time of discovery:

| field | value |
|---|---|
| employee_code | `RSR 0000` |
| active | `true` |
| reason | `Absent 10 consecutive days without approved leave` |
| suspended_on | `07/30/2026` |
| absent_dates | `["2026-07-29","2026-07-28","2026-07-27","2026-07-25","2026-07-24","2026-07-23","2026-07-22","2026-07-21","2026-07-20","2026-07-18"]` |
| awol_group_msg_id | `6287` |
| awol_group_chat | `-5510566104` |
| manual | `false` |
| updated_at | `2026-07-30 02:14:27.164875+00` |

`manual = false` — the boot sweep wrote this, not a person.

The Sunday exclusion worked correctly: 2026-07-26 and 2026-07-19 are both Sundays and both
absent from the list. That part of the logic is sound and must not be disturbed.

### 2.2 The employee row behind it

`employees` where `code = 'RSR 0000'`, fields that matter:

| field | value |
|---|---|
| started_on | `null` |
| created_at | `2026-06-21 07:14:08.671991+00` |
| is_suspended | `false` |
| employment_type | `regular` |
| type_effective_from | `2026-06-21` |

RSR 0000 had exactly **one** attendance row in its entire history — the fabricated
`09:02:18 AM` walkthrough punch on 2026-07-30. It has never had a working pattern. The sweep
nonetheless reported ten consecutive absences.

### 2.3 The missing event row

`select * from public.awol_events where employee_code = 'RSR 0000';` → **no rows returned.**

For comparison, `ZZ WALK3` came out of the *same* sweep in the same session and did receive an
event row (id 19, event `suspended`). Same code path, two different outcomes.

---

## 3. Defect A — null `started_on` produces a phantom absence run

### 3.1 Behaviour

When an employee has `started_on = null`, the sweep appears to walk backwards from today
without a floor, counting every non-Sunday date with no attendance row as an absence. A worker
with no employment history at all therefore looks maximally AWOL rather than not-yet-started.

### 3.2 Why it matters beyond the test code

This is not an RSR 0000 problem. It is a **new-hire problem**. Any real worker entered into
`employees` without `started_on` populated — which is easy to do, since nothing currently
appears to enforce it — will on the very next boot sweep:

1. be flagged with a fabricated multi-day absence run,
2. have an NTE generated against them,
3. be posted to the RSR AWOL Telegram group in front of Jamaica and anyone else in it,
4. and around day six have a non-submission letter auto-drafted.

A new hire's first interaction with the system would be a disciplinary notice for days they
were not yet employed. That is the failure this spec exists to prevent.

### 3.3 Required behaviour

- The absence scan window must never begin earlier than the worker's start date.
- The floor is `started_on` when present.
- When `started_on` is null the sweep must **not** guess and must **not** scan from an
  unbounded past. Preferred: skip the worker for AWOL detection entirely and surface them as a
  data-quality warning (see 3.4). Falling back to `created_at` is acceptable **only** if
  agreed with Raffy first — `created_at` is when the row was typed in, not when the man
  started work, and using it silently would trade a loud bug for a quiet one.
- This is a fail-open path per the standing principle: a worker with missing start data must
  never be flagged, and must never be blocked from punching. Detection uncertainty resolves in
  the worker's favour, visibly.

### 3.4 Surfacing, not swallowing

A skipped worker must be visible, not silently dropped. Use the existing kiosk health-banner
mechanism — the same one that reports unknown employment type — with wording along the lines
of "N worker(s) have no start date and are excluded from AWOL detection." Reuse the existing
pattern rather than inventing a second alerting channel.

---

## 4. Defect B — suspension written with no `awol_events` row

### 4.1 Behaviour

The sweep created an `employee_suspensions` row for RSR 0000, populated its Telegram message
id, and wrote no corresponding `awol_events` row. ZZ WALK3, from the same sweep run, got one.

### 4.2 Why it matters

`awol_events` is the audit trail. The disciplinary workflow's defensibility under DO 147-15
rests on being able to show, per case, what happened and when: detected → NTE issued → served
→ explanation received or lapsed → decision → closed. A case that exists in
`employee_suspensions` with nothing in `awol_events` behind it is a disciplinary action with no
provenance. If that case ever reached a real worker and was later contested, the paper trail
would not survive scrutiny.

### 4.3 Investigate before fixing

Do not patch this by simply adding an insert. Establish **why** the two rows diverged first.
Candidate causes, to be ruled in or out with evidence:

- The event insert and the suspension insert are not in one transaction, and the event insert
  failed or errored without aborting the suspension.
- Events are only written on certain state transitions, and the path RSR 0000 took (possibly a
  first-detection-at-10-days case rather than the normal 3-day trip) does not hit the insert.
- An immutability or guard trigger on `awol_events` rejected the insert silently. Note the
  known pattern from `job_close` / `job_close_audit`: a BEFORE trigger returning NULL blocks the
  write, affects zero rows and raises nothing.
- A PEM/pakyaw exemption branch or similar filter is being applied to the event insert but not
  to the suspension insert.

Report the finding before writing the fix.

### 4.4 Required behaviour

- A suspension row and its originating event row are written **atomically**. Either both exist
  or neither does.
- Any state change to a case writes its event. No path may create or mutate a case silently.
- If a guard trigger is legitimately blocking the insert, the sweep must surface that as a
  visible error rather than proceeding to write the suspension anyway.

---

## 5. Confirm, don't assume: `active` vs `is_suspended`

Tonight's data shows `employee_suspensions.active = true` while `employees.is_suspended =
false` on the same worker at the same moment. The reading — that the sweep opens a case but
does **not** gate the kiosk, and that only the manual owner action flips `is_suspended` — is
consistent with the standing rule that there are no automatic suspensions, only Notices to
Explain.

It is a reading, not a verified fact. **Confirm in the client code which field the kiosk punch
path actually checks, and state the answer plainly in the implementation report.** If the
kiosk reads `active`, then the sweep has been able to lock workers out automatically this whole
time and that becomes the highest-priority item in this spec, ahead of both defects above.

While you are there: the naming is misleading either way. `employee_suspensions.active` reads
as "this worker is suspended" when it means "this case is open." Renaming is out of scope for
this change, but note it in the report for a later pass.

---

## 6. Out of scope

Do not touch these in this change:

- The 3-consecutive-absence threshold and the Sunday exclusion. Both verified working tonight.
- PEM/pakyaw exemption via `employment_type` / `type_effective_from`. Working, leave alone.
- The reinstate dashboard. Blocked on this spec.
- Renaming `active`. Noted above, later pass.
- Julius / PEM 0001 `type_effective_from` correction (STEP 7b). Separate, still awaiting his
  real start date.
- **Plaintext PINs in `employees.pin`.** Discovered tonight — every worker's kiosk PIN is
  readable to anyone with table read access, and PIN-gated actions are what the disciplinary
  paper trail rests on. This needs its own spec and its own walkthrough. Do not fold it in
  here; do not lose it either.

---

## 7. Acceptance criteria

Each must be demonstrated with pasted output, per "measured, not assumed."

**A1.** A worker with `started_on = null` and zero attendance rows is not flagged by the sweep,
appears in the health-banner warning count, and can still punch normally.

**A2.** A worker with `started_on` set to a date three days ago and no attendance since is
evaluated only from that date forward. The absence run reported never predates `started_on`.

**A3.** Sunday exclusion still holds after the change. A run spanning a Sunday omits it, as in
the 2026-07-30 evidence above.

**A4.** A sweep-created case has exactly one matching `awol_events` row, written in the same
transaction. Probe both tables and show the pair.

**A5.** Forced-failure test: with the event insert made to fail deliberately, no
`employee_suspensions` row survives, and the failure is visible rather than silent.

**A6.** PEM/pakyaw workers remain exempt at both app and database layers. Unchanged from today.

**A7.** No path in the changed code sets `employees.is_suspended` automatically. Grep and show
the result.

---

## 8. Test data hygiene

Use fresh ZZ-prefixed codes for the walkthrough, not RSR 0000.

Tonight's teardown scoped its deletes to the fabricated ZZ codes but the scenario also punched
as RSR 0000, whose suspension row therefore survived the teardown and had to be cleaned up
separately. **The rule going forward: every identity a walkthrough writes as must be in the
teardown's scope, not just the fabricated employee codes.** Any table the test identity can
write to — `attendance_records`, `employee_suspensions`, `awol_events`, `leave_requests` — is
in scope for every code used.

Teardown must follow the established pattern: read-only recon first, a guard that aborts on
unexpected state, deletes ordered children-before-parents, and a verify block that compares a
pre-captured list of real worker codes against the post-teardown list.

If the test scenario posts to Telegram, capture the `awol_group_msg_id` and delete the message
as part of teardown. Message 6287 had to be pulled by hand tonight.

---

## 9. Rollout

Standard discipline, no exceptions — this is worker-facing and disciplinary-adjacent:

1. Localhost walkthrough first. Raffy sees it on screen before anything is pushed.
2. Version stamp bumped, format `v2026-MM-DDa`.
3. Stamp verified by eye on live GitHub Pages after the push. Programmatic check alone is not
   sufficient.
4. Fully Kiosk Start URLs updated with the cache-buster on **both** tablets, and the stamp
   confirmed visually on each physical tablet screen.
5. Any SQL is proposed by Claude Code and run by Raffy in the Supabase SQL Editor against
   project `wpmcbjrisuyjvobvzaus`, each step followed by a probe query.

Not pay-adjacent, so no peso diff required. It *is* discipline-adjacent, which is the same
bar for care: a false AWOL flag on a real worker costs more than a rounding error.

---

## 10. Immediate stopgap, already available

Independent of this spec, giving RSR 0000 a start date stops the sweep re-flagging it tonight:

```sql
update public.employees set started_on = '2026-07-30' where code = 'RSR 0000';
select code, started_on from public.employees where code = 'RSR 0000';
```

This is a patch on one row. It does not fix Defect A for anyone else and is not a substitute
for the work above.
