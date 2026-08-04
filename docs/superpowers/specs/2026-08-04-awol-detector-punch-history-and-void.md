# AWOL detector — server-side punch history, and re-detection after a void — Design

> ## AMENDED 2026-08-04 — BUILD ORDER REVERSED, AND §4.2 IS NOT WHAT WAS BUILT
>
> The owner asked to build Defect 2 first. The watermark in §4.2 is **not safe in that order** and
> was replaced by a **mute**. Read this before implementing anything in §4.
>
> **Why the watermark fails if it goes first.** It seals a date permanently — nothing on or before it
> is ever counted again for that worker. But Defect 1 is still live, so the detector still invents
> absences; every void issued now would burn a permanent mark derived from a fabricated count, and
> afterwards nobody could tell which marks were real adjudications and which were bug-silencing.
> Concretely: voiding RSR 0015 sets his watermark to 08/03, so detection reports **zero** for him
> forever — destroying the verification in §6 step 4, which is the only case whose true answer
> (7 days, 07/27–08/03) is known.
>
> **What was built instead — the mute.** `voided_at / voided_by / voided_reason / voided_note` on
> `employee_suspensions`. `awol_set_suspended` refuses to re-activate a voided row and returns
> `false`, which is also what suppresses the kiosk's group alert (`kiosk/index.html:2560`) — one
> return closes both halves of the defect, and every caller (nightly sweep, offline retry queue,
> migration path) goes through it. The muted row still has its `reason` and `absent_dates`
> **refreshed by every sweep**, so the dashboard shows tonight's number, not the number that was on
> screen the day it was voided. **Nothing is frozen**: when Defect 1 ships, RSR 0015's muted card
> goes from 10 days to 7 by itself, with no migration and nothing to unwind.
>
> **Owner decision, 2026-08-04, verbatim:** *"No new case, no group message until I clear the mute.
> The case stays on the dashboard, that's enough."* Release is therefore **manual only**. There is
> deliberately no auto-release: the only honest trigger is "has he punched since?", and that cannot
> be answered truthfully until Defect 1 lands. This also means the two void reasons from §5 Q1
> (`counted_wrong` / `handled_by_owner`) are **recorded but behave identically** for now — their
> only mechanical difference is auto-resume vs suppress-until-punch, which needs Defect 1.
>
> **Revised sequence:** mute (`awol-void-mute.sql`, done) → Defect 1 (§3) → cap 10→21 (§5 Q3) →
> optionally upgrade the mute to the full §4.2 watermark, on data that can be trusted.
>
> §4.2 and §4.3 below are kept as written — they remain the right destination, not the right
> first step.

**Status: §3 (Defect 1) DESIGN ONLY. §4 (Defect 2) BUILT as the mute — see the amendment above.**
Requires the owner's confirmation before any build. Two defects, one document, because the second
one is only survivable once the first is fixed.

**§5 OPEN QUESTIONS: ALL 4 ANSWERED BY THE OWNER, 2026-08-04.** Each answer is recorded at the
question and as a note in the section it governs. All four confirmed the recommendation; three
carried an addition that changed the build:
- **Q1** — a void must record WHY: `counted_wrong` resumes normally, `handled_by_owner` suppresses
  new cases until he punches once. Same watermark, same arithmetic; only the notification differs.
- **Q2** — the marker list is written out explicitly in §3.2.1, read from the live table.
- **Q3** — the cap goes to 21 only AFTER Defect 1 ships; it stays at 10 until then (§6 steps 4→5).

**Still required before any code:** nothing outstanding on these four. The build remains gated on
the kiosk walkthrough (§7).

Owner instruction 2026-08-04: *"read punch history from Supabase — design it, don't build yet, and
design the fix for re-detection after a void."*

---

## 1. The evidence (RSR 0015, Niño Nieto Panut)

Three rows from `awol_events`, one worker, sixteen hours apart:

| When (PH) | Event | Actor | Note |
|---|---|---|---|
| 08/03 16:50 | `suspended` | detection | Absent **6** consecutive days without approved leave |
| 08/03 17:49 | `correction` | owner | Record correction entered 08/03/2026 — **the void** |
| 08/04 07:53 | `detected` | detection | Absent **10** consecutive days without approved leave |

Two independent defects are visible in those three lines.

**Defect 1 — the count went 6 → 10 overnight.** One day passed; the count rose by four. The 08/03
run was CORRECT (6 = 07/27, 07/28, 07/29, 07/30, 07/31, 08/01, with Sundays 07/26 and 08/02 skipped,
chain stopped by his real Time In on 07/25). The 08/04 run added 07/25, 07/24 and 07/23 — two of
which he demonstrably worked:

| Date | Time In | Time Out | Site |
|---|---|---|---|
| 07/25/2026 | 08:15 AM | 05:00 PM | Carmen |
| 07/24/2026 | 08:55 AM | 12:00 AM | Carmen |

**Defect 2 — the void did not hold.** The owner voided the case at 17:49; the next sweep re-created
it at 07:53 the following morning, with a worse charge than the one that was voided.

*(Aside, already fixed: the 08/03 row says event `suspended`, actor `detection` — a machine's name on
a disciplinary act. Commit `d3ec239` corrected that; the 08/04 row correctly says `detected`. No
action needed here, noted so the old row is not mistaken for a live defect.)*

---

## 2. Defect 1 — root cause

Detection asks "did he punch that day?" of the tablet's own `records` map, never of the database:

```js
// kiosk/index.html:2450 (collectAbsentDates), :2426 (isAbsentOnDate), :2472 (hasRecentPunchHistory)
const rec = records[empCode+'_'+d];
const hasTimein = rec && rec.punches && rec.punches.timein && rec.punches.timein !== '(auto-skipped)';
```

`records` is localStorage only. The kiosk **writes** `attendance_records` (`:5703`, `:6058`) and
never reads it back — verified across every Supabase call in the file.

And `records` is pruned to **10 days**, in two places, both of which run before detection:

| Where | Code | Runs |
|---|---|---|
| `cleanupOldData()` `:1871` | `if((today-d) > 10*86400000) delete records[k]` | `:2051`, immediately before `checkAllAbsences()` |
| `loadData()` `:4800` | `cutoff.setDate(cutoff.getDate()-10); if(d<cutoff) delete records[k]` | every boot, before `:5482` detection |

So the detector looks back **21 days** (`collectAbsentDates`, `:2448`) and 30 days
(`hasRecentPunchHistory`, `:2470`) into a map that holds **10**. Beyond the horizon,
`records[key]` is `undefined`, `hasTimein` is `false`, and **missing data reads as absence.**

At 07:53 on 08/04, 07/25 was 10 days + 8 hours old and 07/24 was 11 days + 8 hours old. Both had
been deleted minutes earlier by the cleanup on the line above the detection call.

**Three properties make this worse than a normal bug:**

1. **It only ever invents absences.** A missing record can never turn a real absence into a
   presence. The error runs one way — always against the worker.
2. **It grows with the offence.** A short chain never reaches the horizon. A long chain always
   does — so the defect fires hardest on exactly the cases that end in a letter and a suspension.
3. **The "10 consecutive days" reads as clean data.** The chain cap is `out.length >= 10` (`:2456`)
   and the retention is 10 days. The two are unrelated numbers that happen to coincide, so the
   corrupted result arrives looking tidy rather than obviously broken.

**Also affected, and easy to miss:** `hasRecentPunchHistory()` (`:2469`) reads the same purged map.
Today it accidentally *protects* people — a worker whose only punches are 11+ days old looks
never-punched, so detection skips him entirely. **Fixing `collectAbsentDates` alone would delete that
accidental protection** and start suspending workers the current code silently spares. Both
functions must move to the same data source in the same change.

---

## 3. Defect 1 — the design

### 3.1 Shape: one RPC, fetched once, exactly like `awol_skip_list`

`checkAllAbsences()` already has the right pattern for this (`:2490`): one authoritative
server-side list, fetched once per sweep, before anything writes, with a hard fail-open. The punch
history follows it exactly. Rejected alternatives:

- **Per-worker REST reads** — ~43 round trips on the boot path of a tablet that must stay
  responsive for punching. Same reason `awol_skip_detection()` was rejected for the skip list.
- **Move the whole chain into SQL now** — that is the larger "detection on the database" redesign.
  It is the right destination, but it re-implements Sunday skipping, the leave join, the pending-leave
  HOLD and the cap — all currently reviewed and working — and would need its own walkthrough. This
  design deliberately fixes the data source and leaves the chain logic untouched, so the change that
  goes live is small enough to reason about. It is a step toward that redesign, not a detour from it.

### 3.2 The RPC

```sql
-- Every punched day per worker in one answer. Returns EVERY detectable worker, punched or not,
-- so an empty result is unambiguously a failure and never a legitimate "nobody punched".
create or replace function public.awol_punch_days(p_days int default 31)
returns table(code text, days jsonb)
language sql security definer set search_path = public as $$
  ...
$$;
```

Design constraints on the body, each one load-bearing:

- **`attendance_records.date` is TEXT in mixed `MM/DD/YYYY` and `YYYY-MM-DD` forms.** The window
  filter must normalise inside SQL (a `case` on the shape of the string) and must never be a
  `>=`/`<=` range on the raw text column — the standing landmine.
- **"Punched" = a real Time In** — see the explicit marker table in §3.2.1 below. Nothing about
  which stored values mean "no punch" is left to inference.
- **Codes normalised** the same way `normCode()` does (`RSR 0015` vs `RSR0015`), since codes drift by
  spacing across sources and a mismatch here would silently mean "never punched".
- **Dates returned as ISO** (`YYYY-MM-DD`) so the client compares through `awolISO()` only.
- **31-day window** — 21 for the chain plus the 30-day safety net, one fetch serving both.

### 3.2.1 Marker literals — the explicit list (owner instruction, 2026-08-04)

*"I want to see which stored values mean 'no punch' versus 'punched but auto-filled', not have it
inferred."* Every value below was read from the LIVE table, not from the code — all 1039 rows of
`attendance_records`, every punch column, every non-clock value counted.

**What is actually stored today:**

| Column | Non-clock values found | Count |
|---|---|---|
| `timein` | **none** | — (18 rows `NULL`) |
| `timeout` | **none** | — |
| `lunch_out` | `(missing)`, `(auto-deducted)` | 21, 15 |
| `lunch_in` | `(missing)`, `(auto-deducted)` | 16, 15 |
| `pm_out` | `(missing)` | 11 |
| `pm_in` | `(missing)` | 4 |

**The rule for detection — `timein` only:**

| Stored `timein` | Meaning | Chain |
|---|---|---|
| A clock time (`08:15 AM`, `08:00:00 AM`, `08:00`) | He punched in | **PRESENT — chain breaks** |
| `NULL` or empty/whitespace | No punch on file | **NO PUNCH — counts as absent** |
| `(auto-skipped)`, `(auto-deducted)` | punched-but-auto-filled markers | **NO PUNCH — counts as absent** |
| `(missing)`, `(skipped)` | missing-punch markers | **NO PUNCH — counts as absent** |

The four marker literals are listed defensively, not because they occur: **no marker has ever been
written to `timein` in the entire table.** They are excluded so a legacy row or a future writer can
never smuggle one in as if it were a punch. This matches `isAutoMark`/`isMissingMark`
(`kiosk/index.html:1005`) so the server and the kiosk agree on what a punch is.

**Straight duty needs no special case — confirmed by the data.** `(straight duty)` appears in
`timein` zero times. Straight duty is tracked in `straightDutyRequests`, not as a punch marker, so
such a day carries an ordinary clock Time In and already reads as PRESENT under the first row of the
table. The owner's answer to §5 Q2 is satisfied by the existing shape of the data, with no rule
added.

### 3.3 Client changes

Add one map, fetched once per sweep, alongside `_skip`:

```js
let _punched = null;   // {normCode: Set(ISO date)} — authoritative, server-sourced
```

Then the three read sites change from `records[...]` to a set lookup:

| Function | Now | After |
|---|---|---|
| `collectAbsentDates` `:2451` | `records[code+'_'+d]` | `_punched[normCode(code)].has(awolISO(d))` |
| `isAbsentOnDate` `:2426` | `records[code+'_'+d]` | same |
| `hasRecentPunchHistory` `:2473` | `records[code+'_'+d]` | same |

Nothing else moves. Sunday skipping, the approved-leave break, the pending-leave HOLD, the 3-day
threshold, the cap, the PEM/skip gates and the retry queue are all untouched.

### 3.4 Fail-open — binding

Per the standing rule (*a man always gets to punch and the owner gets TOLD; never a silent block*),
and modelled on the existing skip-list failure path (`:2497`):

**On RPC error, or an empty/short result, abandon detection ENTIRELY for this sweep** — no
suspensions, no alerts, no retry push. Set `awolDetectionSkipped`, render the card, send the
"detection skipped" Telegram, still call `loadSuspensionsFromCloud()` so the bar list stays current,
and return.

This is strictly safer than today: right now a tablet that cannot reach Supabase still runs
detection against stale local data and can open a case on it. After this change, no punch history
means no judgement.

**`records` is not deleted and the 10-day pruning stays.** It is still the right structure for the
day's punching UI; it simply stops being evidence in a disciplinary decision.

### 3.5 How this would have behaved on 08/04

`_punched['RSR0015']` contains `2026-07-25` and `2026-07-24` regardless of tablet age or which yard
punched them. The walk back from 08/03 stops at 07/25. Result: **7 days (07/27–08/03)** — over the
3-day threshold, so still a case, but a truthful one, and no letter naming days he worked.

---

## 4. Defect 2 — re-detection after a void

### 4.1 Root cause

`awol_set_suspended` (`awol-reinstate-flow.sql:137`) re-activates on:

```sql
on conflict (employee_code) do update set active = true, ...
  where employee_suspensions.active is distinct from true
```

A voided case is `active = false`. So it satisfies the condition, is re-activated, returns `true`
newly, writes a fresh `detected` event and fires the group alert.

The deeper problem is that **detection is stateless and the underlying facts are permanent.** The
man really was absent 07/27–08/03. Nothing about voiding the case changes those punch rows, so every
subsequent sweep recomputes the same run and re-opens the same case — nightly, indefinitely. Voiding
treats the *record*; detection reads the *facts*.

There is also **no void action in the codebase at all.** Nothing in `home.js`, `coordinator.js` or
the kiosk writes it — the 08/03 void was performed by hand and its `ref_note` typed manually. So
today a void is an undocumented manual edit that detection is guaranteed to undo.

### 4.2 The design — a resume watermark

Add to `employee_suspensions` (or a small companion table):

| Column | Meaning |
|---|---|
| `detect_resume_after` | date — detection ignores absent days on or before this date |
| `detect_resume_set_by` / `_at` / `_note` | who closed the stretch, when, why |

**Voiding a case sets the watermark to the latest absent date in the case being voided.** Detection
then counts only days *after* it. The absences already adjudicated stop being re-litigated, while
genuinely new absences still accumulate and can legitimately open a NEW case.

Where it enforces, in `collectAbsentDates`: a day on or before the watermark **ends the chain** — the
same way approved leave ends it. It is a closed stretch, not a transparent one.

Rejected alternatives:

- **Match on the stored `absent_dates` set** — fragile precisely because of Defect 1: the same
  absence produced a 6-date set one day and a 10-date set the next. A subset test would have failed
  to recognise them as the same case.
- **A fixed cooldown (N days of silence per worker)** — hides real new absences during the window,
  and the right N is unknowable.

### 4.3 A real Void action

The watermark has to be written by the same action that voids, atomically, or the defect returns in
a new form. Design: a **Void case** button on the AWOL card in the admin dashboard, **behind the
admin PIN and ONLY the admin PIN** (§5 Q4 — the AWOL clerk PIN does not open it), which in one
`security definer` RPC —

1. sets `active = false`,
2. sets `detect_resume_after` to the last absent date of the case,
3. records **which kind of void** it is — `counted_wrong` or `handled_by_owner` (§5 Q1) — since that
   decides whether new cases resume normally or are suppressed until his next punch,
4. writes an `awol_events` row with the real actor's name and the reason,
5. edits the AWOL-group message to show the case was voided.

The UI must make the two reasons a deliberate choice, not a default — two labelled buttons in plain
language (*"Counted wrong"* / *"Real absence, I am handling it"*), never a dropdown pre-set to one
of them. They have different consequences for a man's standing and the log must record which was
actually meant.

`voided` should be its own event in the vocabulary, distinct from `cancelled_leave_approved`
(absence excused by leave), `reinstated` and `kept_suspended` — those all mean different things and
the audit log is the company's evidence if a case is contested.

### 4.4 Interaction with Defect 1

Fixing the void alone would have frozen the *wrong* charge — 10 days including two he worked — and
stopped the nightly repeat without correcting the record. Fixing detection alone leaves a truthful
case re-opening every night. **Neither is safe alone; sequence them Defect 1 first, then Defect 2.**

---

## 5. Open questions — owner decision needed (plain language)

**1. After a void, when may a new case open?**
Niño's case is voided today, but suppose he still does not come to work. Should the counter start
again from zero the day after the voided stretch — so three more absent days open a fresh case in
three days' time — or should he be left alone until he actually punches once?
*My recommendation:* start counting again immediately after the voided stretch. A void says "this
stretch is dealt with", not "stop watching him".

**ANSWERED 2026-08-04 — resume after the watermark, and the void must RECORD WHY.** Two kinds:

| Void reason | Watermark | New cases + group alert |
|---|---|---|
| `counted_wrong` — the case was a data error | set, as designed | resume normally |
| `handled_by_owner` — real absence, the owner is dealing with it | set, identically | **suppressed until he punches in at least once** |

**Both recompute from the same watermark — the arithmetic is identical. Only the notification
differs.** `handled_by_owner` does not change what detection counts; it changes whether the sweep
opens a new case and fires the AWOL-group message.

The suppression clears ITSELF: Defect 1 gives the sweep authoritative punch history, so "has he
punched on any date after `detect_resume_after`?" is already answerable. First punch after the
watermark → hold clears → normal behaviour resumes. No extra state, no flag anyone has to remember
to switch off, nothing that can strand.

**Suppressed is NOT invisible.** The case still computes and still appears on the AWOL card, marked
as held with the reason and who set it. What is suppressed is the NEW case and the Telegram alert —
silence in the group, never silence on the dashboard. A worker quietly accumulating absence with
nobody able to see it is the exact shape the fail-open rule exists to prevent.

**2. Does a "straight duty" day count as showing up?**
A day recorded as straight duty has a Time In but skipped breaks. For deciding absence, it is
plainly a day he was at work.
*My recommendation:* counts as present, chain breaks. Flagging it only because the marker literals
need an explicit list and I would rather you confirm than assume.
**ANSWERED 2026-08-04 — counts as present, chain breaks. Marker list written out explicitly in
§3.2.1**, read from the live table rather than inferred from the code. Result: straight duty needs
no special rule at all — it stores an ordinary clock Time In, and no marker has ever been written to
`timein` in the whole table.

**3. Should the 10-day chain cap stay?**
With correct data the cap rarely matters. But if a man is genuinely absent 15 working days, the
letter would say "10" rather than the true figure.
*My recommendation:* raise the cap to the full 21-day lookback and report the real number. A letter
that understates the absence is a weaker document than one that states it exactly.

**ANSWERED 2026-08-04 — raise it to 21, but NOT in the same change. SEQUENCED:**

| Stage | Cap | Why |
|---|---|---|
| Today, and throughout the Defect 1 build | **10** — unchanged | The sweep is still reading local, purged punch data. The cap is the only thing bounding how large a fabricated count can print. |
| After Defect 1 is live and verified reading real punch history from Supabase | **21** — the full lookback | The data is trustworthy, so the ceiling is redundant and only serves to understate real absences. |

**The cap must not move in the Defect 1 commit.** Raising it while the sweep still reads purged
local data would have raised the ceiling on precisely the error being fixed — RSR 0015's fabricated
run would have printed as up to 21 days instead of 10. The rail comes off only after the thing it
was guarding against is gone. See §6 for where this sits in the build order.

**4. Who may void a case?**
The Void button behind the admin PIN — you only, or also whoever holds the AWOL clerk PIN?
*My recommendation:* admin PIN only. Voiding erases a disciplinary case; the clerk's role is to
confirm the letter was received, which is a different kind of act.
**ANSWERED 2026-08-04 — admin PIN only.** The AWOL clerk PIN does NOT open the Void action. Holding
the clerk PIN must never confer voiding, the same way holding an issuer PIN must never confer time
editing. Accepted consequence: a miscounted case stays open until the owner is reachable.

---

## 6. Build sequence (only after these answers)

1. **SQL** — `awol-punch-history.sql`: `awol_punch_days()`, grants, `notify pgrst`. Canary read
   `select count(*) from public.attendance_records;` and `select current_database();` first, other
   project's tab closed. Verified live by a query touching the new function before any client work.
2. **`kiosk/index.html`** — the three read sites, the `_punched` fetch, the fail-open branch.
   Stamp bump + `preflight.html` EXPECT in lockstep.
3. **Validate** — extract the largest inline `<script>`, `node --check` as an ES module; hygiene
   grep; **run `tests/kiosk-stress/`** — this touches pay-adjacent punch logic.
4. **Re-run detection against RSR 0015 and confirm it reports 7 days, 07/27–08/03**, not 10.
   **The cap stays at 10 through steps 1–4** (§5 Q3) — it is the only bound on a fabricated count
   while the sweep still reads local data, and it must not move in the same commit.
5. **Cap 10 → 21**, as its own small change, ONLY once step 4 has confirmed the sweep is reading
   real punch history from Supabase. Verify by re-running detection and checking a long absence
   reports its true length.
6. **THEN Defect 2** — `detect_resume_after`, the two void reasons (`counted_wrong` /
   `handled_by_owner`, §5 Q1), the void RPC, the dashboard button, its own walkthrough.

## 7. Gates

- Owner confirmation on §5 before any code.
- **Kiosk is the most interactive surface there is → owner localhost walkthrough before any push.**
  No exceptions.
- Detection changes are pay-adjacent by consequence (a suspension stops a man working). Treat every
  change here as pay-affecting.
