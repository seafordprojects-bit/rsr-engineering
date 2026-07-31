# Spec — AWOL detector: merge preconditions and nine defects

**Target path in repo:** `docs/superpowers/specs/2026-07-30-awol-detector-preconditions-and-defects.md`
**Revision:** 2 (2026-07-30, evening). Revision 1 of this filename is superseded — its §3.1 claim that
deployed `main` is safe is **false**, and its §2.2 misclassifies RSR 0014.
**Also supersedes:** `docs/superpowers/specs/awol-detector-start-date-and-event-integrity.md` — its §5
states the inverse of the truth and must not be implemented.
**Blocks:** merge of `awol-suspension-flow` to `main`; AWOL reinstate dashboard build

---

## 0. BLOCKING PRECONDITION — read before touching anything

### The merge gate is C **and** E **and** G. Not C alone.

**`awol-suspension-flow` does not merge to `main` until all three are closed.**

| | |
|---|---|
| **C** | A sweep-created case cannot bar a worker at the kiosk by any path, **and** a barred worker can be reinstated and punch again. |
| **E** | A filed-but-unapproved leave suppresses detection for the dates it covers. |
| **G** | A verbally authorized absence can be recorded on the day, so the detector has something to read. |

**Why C alone is not enough.** C makes a false flag *harmless* — nobody is barred, nobody loses pay.
It does **not** make a false flag *stop*. With C, D and F in place the detector still opens cases,
still posts to the AWOL Telegram group, and in time still auto-drafts non-submission letters —
against **RSR 0005**, whose leave is filed and awaiting approval, and **RSR 0014**, who was absent
with the owner's spoken permission. Neither did anything wrong.

"The alert was harmless" is not a defence if an NTE issued on those facts is ever contested. A
detector that is safe but wrong still puts a notice in an innocent man's file.

**Status 2026-07-30:** C is closed at the database layer and demonstrated (STEP 9). **C's client half,
E and G are all still open.** The three-flag Z1 result is a checkpoint that C+D+F landed correctly —
it is **not** permission to merge. The merge criterion is the final Z1: **one flag, RSR 0015.**

### How C is closed, and why the naming mattered

The kiosk punch gate read `employee_suspensions.active`, which the **sweep** writes. One boolean
meaning "this case is open" was being consumed as "this worker is barred from the tablet" — so a
machine decision barred a man, with no human in the loop. That ambiguity is what produced Allan
Manos's four unrecorded days (§3.1).

`barred_at` is now a separate column that **only a PIN-gated human action can set**, enforced by a
trigger with a transaction-local flag rather than by grants — because a `security definer` RPC runs
as owner and bypasses grants entirely. `active` keeps its meaning: case open, gating nothing.

### Deployed `main` cannot suspend — but it is not inert on absences (Defect I)

Established from `main`'s own code 2026-07-30: it holds **no** `employee_suspensions` write, **no**
`awol_*` RPC call, and `checkAllAbsences()` is a no-op that only clears localStorage. So a
database-layer hold or migration cannot conflict with the live tablets.

**It did still run `checkAndSendAbsenceSMS()` on a daily timer, on the Sunday-unaware counter,
consulting none of the exemptions this branch built** — and its `sms_log` and `violations` writes
never needed the Semaphore key (the key only ever governed whether a phone rang; `public.violations`
is empty for an unrelated reason — an unwired sync function, §10a). Confirmed live: a month of daily
records, absence notices dated on
the Sundays 07/19 and 07/26, and four "your account has been flagged" warnings on 07/28 including a
man who is at work today. See **§10a**.

**DISABLED 2026-07-30 in commit `6f6338f`, kiosk `v2026-07-30a`** — a `return;` at the top of the
function, deployed to `main` and stamped. That stops new false records. It does **not** address the
existing ones, and it is **not** the fix: §10a's four Required items still stand before the path is
ever re-enabled, and the Semaphore key must not be entered until they are done. Separate gate from
this branch's C+E+G merge gate.

### Do not start A or B first

Both are improvements to the *accuracy* of a detector whose *blast radius* is the actual problem.
Fix what a wrong answer costs before fixing how often the answer is wrong. Order of work is §11.

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

### C0 — ANSWERED 2026-07-30. The mechanism, from code, not inference.

**The tablet was running a build from before the 07-26 hotfix.** That build's sweep bars directly,
with no server call and no `try`/`catch` to misread:

```js
if(consecutive>=3){
  suspendedEmployees[emp.code]={reason:`Absent for ${consecutive} consecutive day(s)...`,
    suspendedOn:today,tgMsgIds:{},notified:false};
  saveData();                       // persisted to localStorage rsr_suspended
```

Timeline, reconstructed from his attendance rows:

| Date | |
|---|---|
| 07/21 | last punch, `08:00 AM`, Carmen |
| 07/22, 07/23 | absences 1 and 2 |
| **07/24** | **absence 3 — the sweep bars him and writes it to localStorage** |
| 07/25 | absence 4 |
| 07/26 | Sunday, correctly skipped — **and the day the hotfix shipped** |
| **07/27 →** | he returns, is refused at the Time-In gate, and each refused day adds another absence |

**The suspension was created two days before the hotfix existed.** Nothing had to re-add it after a
wipe; the wipe had not shipped yet.

**Why it outlived the hotfix.** Owner field finding: the Carmen tablet took a fresh load on 07-28
(`?fresh=1785204755780`, Last app start 2026-07-28 10:10), so the hotfix *did* arrive and *did* clear
`rsr_suspended`. By then Allan had stopped trying after Monday's refusal. **The block outlived its
cause in his behaviour, not in storage.** Marked **probable, not proven** — the Carmen tablet's
version stamp was never read directly.

**Corrected reading of §3.2.** Revision 1 was not wrong about `main`; it was wrong to reason about
`main` at all. `main` genuinely carries no case-table reader and genuinely wipes local suspensions.
Both true, both irrelevant to a tablet three builds behind. **"Deployed" is not a property of the
repository** — and nothing surfaced the gap, because `kiosk_health` carries no build stamp. That is
the actual control failure, and it makes §15 step 4 the real safeguard rather than a formality.

### A SECOND, DIFFERENT defect found in the branch — not Allan's cause

Branch `awol-suspension-flow` calls `awol_set_suspended` and then, on **any** error:

```js
}catch(e){
  // offline: block locally, defer the alert to retryAwolUnsynced() when connectivity returns
  suspendedEmployees[emp.code]={...};      // <-- bars him regardless of what the server said
```

A **database refusal** — the pakyaw guard, the non-punching guard, any constraint — is
indistinguishable from being offline, so the tablet bars a man the server explicitly declined to
suspend. This did **not** cause Allan's cascade (the build that blocked him had no RPC at all), but it
would have reproduced the same outcome on deploy while looking like a network hiccup. Removed as part
of Defect C's client half: the sweep no longer writes to `suspendedEmployees` on any path.

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

### 3.6 The bar is DB-shared, but its enforcement reads per-tablet localStorage

Found 2026-07-31 during the Defect C walkthrough, when a barred `ZZ WALK5` passed PIN entry with an
abandoned PM break open. **That was correct behaviour** — but the reason it is correct exposes a
narrower guarantee than "barred at the database, enforced everywhere."

`barred_at` is DB-shared and refreshes every 45s (`setInterval(loadSuspensionsFromCloud, 45000)`).
The **other half** of the gate condition is not:

```js
if(suspendedEmployees[emp.code] && !hasOpenShift(emp.code)){   // kiosk/index.html ~:2095
```

`hasOpenShift()` tests **timein present and timeout absent — today, then yesterday** — read entirely
from that tablet's local `records`. Breaks are invisible to it: `pm_out`, `pm_in`, `lunch_out` and
`lunch_in` are never consulted. Three consequences:

- **A barred man with an open shift keeps passing PIN entry until his `timeout` is written.** This is
  deliberate (§3.4 — refusing him would block his Time Out and let a disciplinary decision become
  unpaid wages), but the window is longer than "the rest of his shift": an abandoned PM break holds
  the shift open until the 19:00 client auto-close.
- **The yesterday branch is never auto-closed.** `autoCloseAbandonedBreaks()` computes
  `const today=todayKey()` and iterates that day only, so an unclosed shift from yesterday satisfies
  `hasOpenShift` all of today and nothing on the tablet will close it. Self-heals the following day;
  a one-day bypass, not permanent.
- **A `timeout` written anywhere else does not close it on this tablet.** `attendance_records` has
  **zero `.select()` calls** in the kiosk — both references are upserts — so `records` never refreshes
  from the database. A payroll Edit-times close, or a close by the *other* tablet, leaves this tablet
  still believing the shift is open. `suspendedEmployees` syncs; `records` does not.

**Net: only the tablet holding the record can end the bypass, and only by writing `timeout` itself.**
Same root cause as the absence chain being computed from localStorage — the detector and its gate
both trust per-device state that no device can correct for another.

**Not a merge blocker.** Every failure mode here is fail-open in the worker's favour, which is the
required direction. Recorded so that "barred means barred on every tablet immediately" is never
assumed — it means *barred from starting work, once that tablet knows and once his own shift is
closed*.

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

## 10a. Defect I — the end-of-day absence SMS path is LIVE on `main`, on the broken counter

**Found 2026-07-30 while answering a different question:** whether deployed `main` could interfere
with a database-layer hold applied during the Defect C walkthrough. It cannot write
`employee_suspensions` and cannot post an AWOL Telegram message — but it is **not** inert on
absences, and the 2026-07-26 hotfix did not make it so.

### What the hotfix actually disabled, and what it left running

The hotfix neutralised `checkAllAbsences()` — on `main` its whole body clears
`suspendedEmployees` from localStorage (`kiosk/index.html:2242`), and
`sendAbsenceSuspensionAlert` has **zero callers**. That half is genuinely off.

**`checkAndSendAbsenceSMS()` was left live, driven by the same counter the hotfix condemned.**

| | |
|---|---|
| **Trigger** | `setInterval` every 30s (`:1735`). At `endH:endM` it fires `sendSummary(); autoExportCSV(); checkAndSendAbsenceSMS(); …`. **A daily timer. Automatic, no human in the loop — confirmed from the live `sms_log`, which holds over a month of daily records.** `endH,endM` defaults to `17,0` (`:1093`) and is loaded from **each tablet's own `rsr_settings` localStorage** (`:4376`), set from the Settings field (`:3525`) — so it is per-device, not a shared setting, and two tablets can fire at different times. |
| **Rest day** | **No guard on the run day at all.** The job runs on Sundays and, since nobody punches, treats the rest day itself as absence day 1. This is a SECOND Sunday bug, distinct from the counter. |
| **Scope** | Every employee (`:4493`). Skips only an **Approved** leave (`onLeaveToday`) and anyone with a `timein` today. |
| **Counter** | `getConsecutiveAbsences()` (`:2222`) — the **Sunday-unaware** one. The comment at `:2233` documents this exact flaw *for the suspension path* and leaves it driving SMS. On a Monday a man who missed only Friday and Saturday reaches 3. |
| **Messages** | Texts the worker at 1, 2 and 3 consecutive days. At 3: *"AWOL Warning: … you have been absent for 3 or more consecutive days without approved leave … Your account has been flagged."* (`:4480`) |
| **Violation** | At exactly 3 it writes a violation record (`:4505-4510`) — **unconditionally, and independent of the Semaphore key**: the `if(consecutive===3)` block is a sibling statement, not nested in the SMS branch and not conditioned on `result.success`. It lands in **localStorage only** (`rsr_violations` via `saveData()`), because `syncViolationToSupabase()` (`:5278`) **has zero callers**. See the correction below — the empty `violations` table is an accident, not a guard. |
| **Only brake** | `sendSMS`'s `if(!semaphoreKey||!phone)` guard. `semaphoreKey` is loaded from saved settings (`:4389`) or **typed into kiosk Admin → Settings** (`:4453`). |

### Why this is a defect and not a configuration state

**The brake is not a design decision, it is an empty field.** The key goes live the moment it is
entered in the Admin panel — no deploy, no review, no code change. The owner has the SMS fix on his
list, so both protections (missing key, and any phone left blank) are temporary by intention.

**It consults none of the exemption authority this branch built.** No `awol_skip_list()`, no
`awol_skip_detection()`, no pending-leave check, no `is_non_punching`, no pakyaw check, no site
capture.

**Who is actually exposed — the `1..3` bound matters.** `if(consecutive>=1&&consecutive<=3)` means
only a worker at **exactly 1, 2 or 3** absent days is texted, so the population is not the chronic
non-punchers. On the Sunday-unaware counter as of 2026-07-30, **RSR 0015 sits at 5** (07/29, 07/28,
07/27 plus 07/26 counted as absent, +1 for today) and **RSR 0014 is weeks out** — both fall *outside*
the window and would not be texted. **RSR 0035 is excluded today** by his 14:19 punch (`hasTimein`).
The four Mandaue men, the five pakyaw men and Jamaica sit far past 3 for the same reason. **This is
luck, not design** — none of it is a rule the code applies.

The genuinely exposed population is anyone passing *through* days 1–3, which rotates daily:

- a worker taking a short absence with the owner's spoken permission — **exactly RSR 0014's and
  RSR 0035's situation, caught in its first three days instead of its third week**;
- a worker whose leave is filed and undecided — **RSR 0005**, once his run is 1–3;
- **the Monday case**: missed Friday and Saturday only, counted as 3 by the Sunday-unaware counter,
  texted *"your account has been flagged"* on the first morning back;
- any Mandaue or pakyaw man in the three days following a single punch, and **Jamaica** likewise —
  she is the sole authorized AWOL clerk.

**And the violation half is live today.** It needs no key. Any evening a worker hits exactly 3 on the
Sunday-unaware counter, a violation is recorded and can reach `public.violations`.

### CONFIRMED FROM THE LIVE `sms_log` — this is not a hypothetical

Read by the owner from production `sms_log`, 2026-07-30. **Over a month of daily records, every one
`Failed`** — the Semaphore key was absent throughout, so no worker's phone ever rang. Every row below
nonetheless exists in production as a dated record with its full message text.

| Date | What the records show | Why it is wrong |
|---|---|---|
| **2026-07-19** | absence notices dated on a **Sunday** | the rest day itself counted as absence day 1 |
| **2026-07-23** | a notice to **Jamaica L. Batucan (RSR 0025)** | she is office-based and **does not punch** — Defect F's whole subject, and the sole authorized AWOL clerk |
| **2026-07-26** | absence notices dated on a **Sunday**, to **seven men** | same rest-day bug, seven false records in one run |
| **2026-07-28** | **four day-3 "your account has been flagged" warnings**, including **Alvin H. Operio (RSR 0005)** and **Edwin Lacno** | Alvin's leave was **filed and awaiting decision** (Defect E). Edwin **is working today** — his "3 consecutive absences" was false when written |

**The Sunday defect is proven twice over**, by two independent mechanisms in the same path: the
Sunday-unaware counter (`getConsecutiveAbsences`), and the absence of any rest-day guard on the run
day. 07/19 and 07/26 are Sundays; the notices are dated *on* them.

**Edwin Lacno is the sharpest case.** A man at work today holds a production record stating he was
absent three consecutive days without approved leave. Had the Semaphore key been present on 07/28 he
would have been told by text that his account was flagged. Confirm his employee code and check
whether a `violations` row accompanies the notice.

**Trigger time — one open question.** The owner read these as a 09:00 daily timer. `sms_log.timestamp`
is `Date.now()` epoch milliseconds and **09:00 UTC is exactly 17:00 Manila**, the `endH,endM` default,
so this is most likely the editor rendering UTC. Resolve before relying on it: if the timestamps
really are 09:00 **Manila**, that tablet's `endH` is 9 rather than 17, and the same variable also
drives `shiftEndW` (`:1018`), the late-Time-In `lateFlow` (`:2430`) and `:2666` — a misconfiguration
with a far wider blast radius than this defect. Query in the session notes; not yet run.

### `public.violations` is EMPTY — and why that is not the reassurance it looks like

Queried by the owner 2026-07-30: **zero rows.** Two candidate explanations were tested against the
code, and both were wrong.

**Not "the write is downstream of a successful send."** It is not. `:4505-4510` is a sibling
`if(consecutive===3)` statement — not nested in the `if(consecutive>=1&&consecutive<=3)` SMS branch,
and never reads `result.success`. The four men who took a day-3 warning on 07/28 each incremented a
violation. The Semaphore key has **no bearing** on it.

**The actual reason: `syncViolationToSupabase()` (`:5278`) has exactly one occurrence in the file —
its own definition. Zero callers. It is dead code.** Every sibling sync function (`syncEmployeeTo…`,
`syncSmsLogTo…`, the leave sync) *is* called. This one was never wired up, which is why `sms_log`
filled for a month while `violations` stayed empty.

**So the records exist — they are just not in the database.** Three consequences:

1. **They are on the tablets.** `absenceViolations` persists to `rsr_violations` in localStorage and
   is rendered by `renderViolationList()` in the kiosk Admin panel (SMS-log tab, `:4770`). **"Edwin
   is clean" is true of the database and probably false of the Carmen tablet's own violation list.**
   Check that screen before concluding no record of him exists.
2. **They have left the tablet by another route.** The monthly-records JSON export carries
   `absenceViolations` verbatim plus a `totalViolations` sum (`:1843`, `:1851`), filename
   `<company>_monthly_records_<date>.json`. Any export already produced contains them.
3. **The protection is one line from being undone.** An uncalled sync function reads as an
   oversight, not a decision. The moment anyone wires `syncViolationToSupabase()` up — a plausible
   "finish the sync" tidy-up — **the entire localStorage backlog flushes into `public.violations` at
   once**, including every false entry from the Sunday runs. The empty table is luck.

**Corrected conclusion.** The missing Semaphore key was protecting exactly **one** thing: whether a
worker's phone rang. It never protected the records. What kept the disciplinary rows out of the
database was an unwired function, and that is a weaker guarantee than a missing credential — a key
has to be typed deliberately, whereas dead code invites being connected.

### The branch forked one commit BEFORE the disable — the merge resolution is load-bearing

Established 2026-07-31 from the git history, not inferred.

| | |
|---|---|
| Disable committed | `6f6338f`, author `2026-07-30T20:34:35+08:00`, committed `20:35:20+08:00`, pushed immediately after |
| Last SMS fired | 17:00 Manila on 07/30 — **~3.5 hours BEFORE the disable existed** |
| Branch contains it? | **No.** `git merge-base --is-ancestor 6f6338f awol-suspension-flow` → false. Fork point is `1cd49e5`, the commit immediately before |

So the 07/30 fire neither defeated nor tested the disable; it is the last legitimate one. **The first real test is 17:00 Manila on 07/31.**

**And `awol-suspension-flow`'s SMS timer was live.** `:1770` still called `checkAndSendAbsenceSMS()` and the function had no early return — so any localhost session open across 17:00 could write `sms_log` rows. That directly contradicts the walkthrough method, which spans 17:00 by design (the GI-SUSPEND test needs the afternoon Time In window). Merged 2026-07-31 for exactly that reason.

**MERGE RESOLUTION RULE — the branch and `main` both modified the same opening lines of
`checkAndSendAbsenceSMS`, so every future merge of this function conflicts.** `main` added
`return;` at the top; the branch rewrote the opening to add a Sunday run-day guard.

> **Keep `main`'s `return;` on top. Put the branch's Sunday guard underneath it.**
> Resolving in favour of the branch alone silently re-enables Defect I — deployed, with no visible
> symptom until the next 17:00.

### Two Sunday bugs, one of them already fixed on the branch

The branch carries a **run-day** guard `main` never received:

```js
const todaySunday=isSundayKey(todayKey());
…
if(todaySunday)continue; // no-punch Sunday = rest day, not absent — don't SMS/log
```

That closes the bug behind the 07/19 and 07/26 spikes — **the two largest days in `sms_log`, 10 and 17 messages**, sampled rows all day-1 notices to men who had punched the Saturday. On the branch those Sundays send nothing.

**The second Sunday bug is untouched.** The counter is still `getConsecutiveAbsences(emp.code)+1`, which is Sunday-unaware, so a rest day still inflates the *count* even when it no longer triggers a *run*. Confirmed live: **Alvin (RSR 0005) took a day-2 notice on Monday 07/27**, which is only possible if Sunday 07/26 was counted as day 1. Suppressing the Sunday run does not fix the Sunday count.

Branch status against the Required list: **#3 half done** (run day yes, counter no); **#1, #2, #4 untouched**.

### No dedup exists — and 07/30's single row does not prove one

`syncSmsLogToSupabase` is a bare `.insert()` with no `onConflict`, and `sms_log` carries no unique
index or constraint anywhere in the repo SQL. Nothing prevents two devices writing the same
`(employee_code, date, day)`.

07/30 had **two candidate writers at 17:00** — the Carmen tablet on pre-disable `main`, and the
localhost branch kiosk — yet produced **one row**. The reason is not dedup:

**The localhost build cannot qualify anyone.** Its `records` map is empty, because the kiosk has
**zero `.select()` calls on `attendance_records`** and never pulls history down. So
`collectAbsentDates` finds no punch on any day, runs to its `out.length>=10` cap, and
`getConsecutiveAbsences()+1` returns **11** — outside the `consecutive>=1 && consecutive<=3`
window. No SMS, no violation. The same empty-records fact that made the ZZ WALK sweep silent during
the Defect C walkthrough also made the localhost kiosk incapable of sending day-1..3 notices.

**One row, one writer — the Carmen tablet.** Nothing was preventing a double-send; the second device
simply never reached the threshold. **The rebuild must ADD a dedup that has never existed**, because
once two commissioned tablets both hold real local history they will both qualify the same man on the
same evening and send twice.

### The counter bug, MEASURED: every Sunday-spanning chain warns a day early

Not a theoretical off-by-one. Measured from `sms_log` 07/28–07/30, 2026-07-31.

**All four day-3 "your account has been flagged" notices on 07/28 — RSR 0004, RSR 0005, RSR 0015,
RSR 0024 — chain back to Sunday 07/26 as their day 1**, the 17-message spike. Counting forward:
07/26 Sun = 1, 07/27 Mon = 2, 07/28 Tue = 3 → final warning.

**Under the detector's own rule, a no-punch Sunday is transparent.** Drop it and the same four read:
07/27 = 1, 07/28 = 2. **All four were at day 2 when they were told their account was flagged.**

So the consequence is not "a number is wrong" — it is that **the disciplinary threshold is announced
to a worker a full day before the policy is met, on any chain that spans a Sunday.** Since the
absence window most workers hit begins Monday, spanning a Sunday is the common case, not the edge.
Had the Semaphore key been present, four men would have been told in writing that they had breached
a three-day rule they had not yet breached.

### The SMS counter and the detector's chain disagree on BOTH ends

They are two different definitions of "how many days absent", and neither device knows the other's
answer:

| | SMS path | Detector chain |
|---|---|---|
| Today | **counted** — `getConsecutiveAbsences(emp.code)+1 // +1 for today`; and suppressed entirely by a punch today (`if(hasTimein)continue`) | **ignored** — `collectAbsentDates` starts at `i=1`, yesterday |
| Sunday | branch guards the RUN day only; the counter still counts it | transparent, does not count and does not break |

Measured both ends: **Anthony's 07/30 day-2 names 07/30 itself**, and **June Dimco's same-day punch
silenced his notice** — neither is true of the chain.

**And the divergence has Allan's exact shape.** A man who returns to work today gets **no SMS**
(punched today ⇒ suppressed) while the detector, which ignores today, still counts his prior run and
**opens a case anyway**. He is told nothing and suspended regardless — §3.1 in miniature, arriving
through the notification path instead of the lockout.

### Silence after day 3 means two opposite things

The `consecutive<=3` upper bound makes the system go quiet exactly when a case escalates, and the
silence is indistinguishable from resolution. Measured on the same four:

- **RSR 0004 and RSR 0024 went quiet by RETURNING** — both present in the A1 baseline for 07/30.
- **RSR 0005 and RSR 0015 went quiet by getting WORSE** — both at run 4 in A5 on 07/31, past the
  window's upper edge.

Same silence, opposite meanings, no signal either way. A supervisor reading `sms_log` cannot tell a
man who came back from a man now four days absent.

### MEASURED 2026-07-31: a PAKYAW man qualified for a day-1 notice

Not inferred from reading the code — measured live, on the evening of the disable, with
`docs/superpowers/specs/qualifying-worker-0731.sql` modelling the deployed counter exactly.

**Two men qualified at Carmen, both at day 1, and one of them was `PEM 0004` (Erwin) — pakyaw.**

The pakyaw exemption is the oldest and best-established rule in this system: `awol_is_pem()`
server-side, `awolExemptState()` in the kiosk, `employment_type` as the single source, all of it
verified live. **None of it reaches the SMS path.** `checkAndSendAbsenceSMS` applies no code filter,
never calls `awol_skip_list()`, and never reads `employment_type` — so a pakyaw man is a candidate
for a worker-facing absence notice on exactly the same terms as anyone else.

This is the concrete instance of the general finding above ("it consults NO exemption"). It matters
more than the general form because it is dated, named, and would have been a message to a man whose
absence is not measured in days at all.

**AND THE ONLY THING THAT SAVED HIM WAS A BLANK FIELD.** Measured the same evening: the active roster
holds **eight** workers with no phone number, and they are **all five pakyaw men**, plus `RSR 0000`,
`Elias Entero` and `Chrismark Ybas`. `sendAbsenceSMS` returns on `!emp.phone` before composing
anything, so **5 of 5 pakyaw men are currently unreachable by this path for one reason only: nobody
has entered their number.**

That is not an exemption. It is a data gap standing in for a rule, and it is one edit away from
gone — from the ordinary Admin employee form, by someone doing the obviously correct thing.

**The sequencing hazard is real and immediate.** There is a legitimate ops task waiting — Semaphore
needs numbers for **Elias Entero and Chrismark Ybas**, both regular workers who should have them. The
moment phone data is completed for completeness' sake, **the accidental protection over all five
pakyaw men disappears with it**, silently, on a path that has no code filter. The backfill is right;
doing it before the filter is not.

**Mandaue returned zero rows in the same run**, confirming the second accidental protection recorded
under Required #7: it holds no punch history, so every worker ran to the counter's 7-day cap and
landed at day 8, outside the `1..3` bound. Structural silence, not a rule.

**Neither the notice nor a violation would have left evidence that night** — both men have no phone,
so `sendAbsenceSMS` returns before writing `sms_log`; and both were at day 1, while the violation
write is gated on `consecutive === 3` exactly (`main:4532`). So 2026-07-31's quiet `sms_log`
**discriminates nothing on its own**. The disable is not yet measured; see the file for what a clean
kill requires.

### The message asserts state the system never checked

**"Your account has been flagged" was false for all four men who received it on 07/28.**

- **Measured** for RSR 0005 and RSR 0015: A4a on 2026-07-30 returned **no suspension rows at all**
  for either. Nothing had been flagged.
- **Structural** for RSR 0004 and RSR 0024: the build that sent the message carries the 2026-07-26
  hotfix, under which `checkAllAbsences()` is a no-op. That build **cannot create a case**, so no
  case could have existed to describe.

The sentence is produced from the counter's arithmetic (`consecutiveDays>=3`) and **never reads a
case row**. When it happens to be true it is coincidence — Allan's 07/24 day-3 was "true" only
because his lockout case already existed for unrelated reasons. A worker-facing disciplinary
assertion has been generated by an `if` on an integer.

**And Defect E reaches the wording, not only the send decision.** Alvin's day-3 read *"without
approved leave"* while his leave sat **filed and awaiting the owner's decision**. The template has no
way to represent *pending* — it offers only "approved" or nothing — so even a version of this path
that correctly declined to *suspend* him would still have told him, in writing, that he had no leave
on file. Suppressing the send is necessary but not sufficient; the sentence itself is unrepresentable
for his actual state.

### The old template costs two SMS segments per send

The 07/28 text runs **≈210 characters**. GSM-7 single-segment is 160, so every one of those notices
billed as **two segments** — double cost on a path that was sending daily to multiple men. The
Bisaya replacement set already sits at ≤160; that is a property worth pinning as a requirement rather
than leaving as an accident of the current wording.

### Required, in addition to the four below

5. **Clear `rsr_violations` on the tablets**, mirroring what commit `c6696df` did for
   `suspendedEmployees` — a boot-time clear in the next kiosk build is the safe route. Do **not**
   clear site data to achieve it: that also destroys the punch sync queue (§14, and the
   local-clear-before-DB-delete rule).
6. **Leave `syncViolationToSupabase()` unwired, or delete it.** If it is ever connected, it must be
   connected *after* items 1–4, never before — otherwise the fix ships the backlog.
7. **ONE NOTICE PER WORKER PER DAY, ACROSS ALL DEVICES, ENFORCED SERVER-SIDE.**
   No dedup has ever existed: `sms_log` carries no unique constraint and `syncSmsLogToSupabase` is a
   bare `insert`. **The only thing that has ever prevented a double-send is which device happened to
   be awake at 17:00** — on 07/30 the Carmen tablet was the sole writer because the other candidate,
   the localhost build, had an empty `records` map and computed every worker to 11 consecutive
   absences, outside the `1..3` window. That is luck, and it expires the moment a second device holds
   real attendance history.
   **Client-side checks are not sufficient** and must not be the mechanism: each tablet reads its own
   localStorage, so two tablets can each believe they are the first to notify. Enforcement belongs in
   the database — a unique index on `(employee_code, date, day)` at minimum, with the send path
   claiming the row **before** dispatching rather than logging after, so a losing device never sends
   at all. A client-side pre-check may exist as an optimisation, never as the guarantee.

   **What has been preventing a double-send, so it is not mistaken for a design.** Two unrelated
   accidents, both expiring. **(a) A one-minute window with no catch-up.** The fire is
   `setInterval(…,30000)` at `:1770` testing `now.getHours()===endH && now.getMinutes()===endM`;
   `summaryDone` (`:1162`) is an in-memory `let`, **never persisted**, cleared 70s later — a
   re-entry guard, not a fired-today flag. Miss the minute and nothing fires that day, silently and
   with no retry. Only an awake, foregrounded device fires; the kiosk's wake lock (`:1956`) keeps a
   tablet's timers alive while a background browser tab gets no such protection.
   **(b) Devices without local punch history compute out-of-window counts.** The counter reads
   per-device localStorage; a device with no history counts every day absent, hits the
   `out.length>=10` cap and returns 11 — outside `1..3`, so it can never send. That is why the
   localhost build never wrote a row, and why **Mandaue cannot send even when awake** until it
   accumulates real punches.
   Neither is a dedup. Both fail the moment two commissioned kiosks hold real history and wake locks
   at 17:00.

8. **ONE server-side counter, using the detector's chain definition, shared by SMS and detection.**
   Today there are two definitions and they disagree on both ends (see above): the SMS path counts
   TODAY and is silenced by a punch today; the chain ignores today entirely. Sundays differ too.
   **The day a man is TOLD must be the day the system ACTS on** — a notice that says day 3 while the
   detector holds day 2 cannot be defended in a twin-notice process, and the reverse lets a
   returning worker be suspended without ever being warned. Supersedes and absorbs item 3: it is not
   enough for SMS to adopt `collectAbsentDates`, the two must read the same computation from the
   same place.

9. **Distinguish RETURNED from DEEP-AWOL.** The `consecutive<=3` bound makes the system fall silent
   precisely when a case escalates, and that silence is identical to the silence of a man who came
   back — measured on the four 07/28 warnings: 0004 and 0024 returned, 0005 and 0015 went past the
   window. The rebuild must emit a distinct signal for crossing the upper edge (escalation), and a
   distinct one for the chain breaking (return), so no reader has to infer which happened from an
   absence of messages.

### Required

1. `checkAndSendAbsenceSMS` consults **`awol_skip_list()`** — the same single authority as the sweep,
   fetched once, with the same fail-open-on-error-or-empty rule (§6). A worker absent from the list is
   skipped and reported, never texted.
2. It honours **E** (a filed-but-unapproved leave suppresses it) and **G** (a recorded verbal
   authorisation suppresses it). A "your account has been flagged" SMS is a disciplinary
   communication to the worker — it must not precede a decision the owner has not yet made.
3. It uses the **Sunday-aware** counter (`collectAbsentDates`), not `getConsecutiveAbsences`.
4. The violation write moves behind the same gate, and is **not** conditional on the SMS succeeding —
   today it fires whether or not a message is sent, which is how it became live unnoticed.

### Gate implication — read this precisely

**Defect I does not join the C+E+G merge gate for `awol-suspension-flow`.** That gate is about what
this branch ships. Defect I gates a different door: **the Semaphore key must not be entered on any
tablet until 1–4 above are done.** Adding it to the merge gate would delay a branch that reduces
blast radius, in the name of a path that branch does not touch.

Two consequences worth stating:

- **If the SMS fix lands before this branch merges, the order reverses** — the SMS path would then
  need E and G, which are merge-gate items here, so whichever ships second inherits the dependency.
  Do not fix SMS and this branch in parallel without deciding which is first.
- **The violation write is live now and gated by nothing.** That part does not wait for either.

10. **A MESSAGE MAY ASSERT ONLY STATE THE SAME TRANSACTION CREATED OR READ.** "Your account has been
    flagged" must come from the case row — read it, or do not say it. Today the sentence is emitted
    on `consecutiveDays>=3` alone and was false for all four men who received it on 07/28: measured
    false for RSR 0005 and RSR 0015 (no suspension rows existed), structurally impossible for
    RSR 0004 and RSR 0024 (the sending build cannot create a case). No worker-facing disciplinary
    claim may rest on an arithmetic comparison. The same rule covers dates, day counts and
    leave status: if the send path did not read it, the message does not state it.

11. **The template must be able to represent PENDING leave — or never reach a man whose leave is
    pending.** Alvin's day-3 read "without approved leave" while his leave was filed and awaiting
    decision. Defect E therefore reaches the WORDING, not just the send decision: a fix that only
    suppresses the send still leaves a template that can describe no state between "approved" and
    "nothing on file". Whichever way it is resolved, the outcome must be that no worker is told he
    has no leave on file while his request sits in the owner's queue.

12. **Every message ≤160 characters (GSM-7 single segment).** The old template ran ≈210 and billed as
    two segments on every send. The Bisaya set already satisfies this; pin it so the property
    survives the rebuild rather than depending on whoever writes the next wording.

13. **THE CODE FILTER IS A PRECONDITION FOR THE SEND PATH GOING LIVE, AND PHONE-DATA
    INCOMPLETENESS MUST NEVER BE THE PROTECTION.** Measured 2026-07-31: `PEM 0004` qualified for a
    day-1 notice and was stopped only by `sendAbsenceSMS` returning on `!emp.phone`. The eight
    phone-less actives are all five pakyaw men plus `RSR 0000`, `Elias Entero` and `Chrismark Ybas`
    — so the pakyaw exemption survives in this path at **5 of 5, by blank field alone**.
    Two consequences, both binding:
    **(a)** the send path does not go live until it consults `awol_skip_list()` (Required #1) — a
    missing phone number is not a policy and cannot be relied on as one; and
    **(b) SEQUENCING.** Semaphore legitimately needs numbers for Elias Entero and Chrismark Ybas.
    Completing phone data **before** the code filter ships removes the accidental protection from
    all five pakyaw men at the same stroke, silently, from the ordinary Admin employee form. **Do
    the filter first, or do the backfill only while the path is disabled.** Whoever collects those
    two numbers must know this; it is not obvious from the form.

---

## 11. Order of work

1. **§3.2 — how Allan was blocked on deployed `main`.** Diagnosis only, no code. Nothing else
   is safe to reason about until this is known.
2. **Defect C** — separation of case-open from worker-barred, plus a working reinstate path.
3. **Defects G, H, D, E, F** — the false-positive sources. Together they account for eight of
   nine.
4. **Defect B** — audit integrity, before any real case is opened against a real worker.
5. **Defect A** — new-hire trap, no live instance.

**Off this ladder, on its own clock: Defect I (§10a).** Not gated by the above and does not gate it.

**Bleeding stopped 2026-07-30** — commit `6f6338f`, kiosk `v2026-07-30a`, the path disabled with a
`return;`. What remains is in three parts, and only the first is urgent:

1. **Review the records already written.** A month of `sms_log` rows in the database, including four
   false day-3 warnings. `public.violations` is **empty** — but only because its sync function was
   never wired up; the violation records themselves exist in tablet localStorage and in any monthly
   JSON export, and would flush to the database the moment anyone connects `syncViolationToSupabase()`.
   §10a has the detail. **Edwin Lacno is at work holding a record that says he was AWOL** — check the
   Carmen tablet's own violation list, not just the database, before calling him clean.
2. **The real fix**, per §10a's **thirteen** Required items — it was four when first written; the
   measured evidence added five more, of which #7 (server-side dedup), #8 (one shared
   counter), #9 (returned vs deep-AWOL) and #10 (a message may assert only state the same
   transaction read) are new *design* obligations, not just corrections — #10 in particular is
   a rule about worker-facing text that no amount of counter fixing satisfies. Still needs E and
   G, which are C's merge-gate siblings, so "do Defect I first" resolves to "do E and G first" — it
   reorders nothing.
3. **The Semaphore key stays out of every tablet** until 2 is done.

---

## 12. Out of scope

- The 3-consecutive-absence threshold and Sunday exclusion. Both verified correct (the evidence
  correctly omitted 07/26 and 07/19). **Scope note added 2026-07-30:** that verdict covers the
  branch's `collectAbsentDates`. It does **not** cover `getConsecutiveAbsences`, which is
  Sunday-unaware, still live on `main`, and still driving the SMS path — §10a.
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

**C0. ANSWERED 2026-07-30** — see §3.1. Pre-hotfix build barred directly; created 07/24, two
days before the hotfix shipped. Probable-not-proven on why it outlived the 07-28 fresh load.
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

### CLIENT HALF OF DEFECT C — committed 83b9c89, then verified 21/21

Committed at **83b9c89**, and the commit message says plainly that the smoke test was red and the
changes were syntax-verified but untested. **That is now out of date in the good direction:** the
harness was fixed afterwards and passes **21 of 21**, including six new Defect C assertions. Read the
harness result, not the commit message.

What the client half does:

- The sweep writes `suspendedEmployees` on **no path**. Three writes removed: the success path and
  both halves of the error path. The error path was the dangerous one — it treated any RPC failure as
  "offline" and barred locally, so a DATABASE REFUSAL was indistinguishable from a network drop.
- `loadSuspensionsFromCloud` filters on `barred_at`, not `active`. `suspendedEmployees` therefore
  means BARRED BY A HUMAN. All six readers of that map were checked.
- `awol_skip_list()` once per sweep, fail-open on error **or empty**.
- `retryAwolUnsynced` moved below that fetch and consults it; a queued case for a now-exempt worker
  is dropped and **recorded** persistently, never rewritten by a sweep.
- `kpBusy`, a real flag checked explicitly by `updBtns`.
- The `:2058` gate refreshes **before** refusing, and refuses only when there is **no open shift**.
  Time In refused; every other punch allowed, because blocking the lunch pair would zero the morning
  as well as the afternoon.
- Dashboard reinstate button, PIN-gated through `awol_set_barred`, in **both** lists.

### The smoke test: what actually happened, and what it means for earlier claims

**The harness was never broken by the merge.** The failure that stopped work was a **flake** — a
30-second timeout on the coordinator's first page load. On re-run with page-error logging added, the
coordinator section passed unchanged. My diagnosis that main's newer `coordinator.js` had broken it
was wrong.

**But the fixture change had never been committed.** `PEM 0009` appears **zero** times in the
pre-merge branch tip (`1a0fe38^1`); the smoke test file's previous commit was `478e068`, predating
this session entirely. So every smoke-test number reported before 83b9c89 was measured against an
**uncommitted working tree that no longer exists**, and two of those reports — 14, then 13 — are
mutually inconsistent. One was wrong and it cannot now be determined which.

Three claims rested on those runs. All three are **now verified by the 21/21 run**, but they were
**not** verified when they were asserted:

1. "The PinPad extraction is verified post-merge."
2. "The `employment_type` exemption change is verified."
3. The merge verification itself — the harness was **not** re-run after the merge changed
   `coordinator.js` by 197 lines. That omission is what let the flake hide.

The SQL work is unaffected throughout: every step of `awol-defect-cdf.sql` rests on probes the owner
ran and pasted against production.

### Two harness defects fixed, both of which hid this

**Assertions could be skipped silently.** The first uncaught timeout killed the run and every later
assertion was simply absent from a smaller total — six Defect C assertions sat behind a failing
section and never executed, which reads as coverage in review while proving nothing. A `section()`
runner now records one failure and continues, so the total is always the full set.

**Browser errors were swallowed.** A page could throw during load, leave a card empty, and the only
symptom was a selector timeout 30 seconds later with no cause. Every page is now wired for
`pageerror`, `console.error` and `requestfailed`.

Two smaller things worth not rediscovering: the Lock screen keypad is `button:has-text(d)` while the
AWOL card's PinPad is `button[data-admin-key=d]`, and the PinPad does not exist until a decision
button opens it. And the card verifies the passcode via `admin_verify_passcode` **before** calling
`awol_set_barred`, so a wrong PIN shows the card's "Wrong PIN." and never reaches the RPC's
"Not authorised" — defence in depth, since the RPC still verifies inside.

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

**A SERVER-SIDE STAGING VERIFY CAN PASS WHILE THE CLIENT IS BLIND — stage where the code reads, and
verify there too.** (2026-07-31.) The Defect C walkthrough staged a backdated punch into
`attendance_records` and its B4 gate confirmed, server-side, that both test identities were
detectable, that `awol_effective_site` resolved to Carmen, and that the roster totalled 45 · 13 · 32.
Every check passed. **The sweep then did nothing at all, silently**, because the kiosk has **zero
`.select()` calls on `attendance_records`** and builds its `records` map from localStorage only — so
`hasRecentPunchHistory()` saw no punch, hit the 30-day safety net's `continue`, and returned before
the RPC, before any Telegram, and without a single console line. Two boots an hour apart produced
identical silence, which is indistinguishable from "never ran": the sweep writes **no** console
output on **any** path (`logNotif` appends to an in-app array, never `console.*`).

Two rules follow:

- **Verify the staging in the layer that consumes it.** A server-side assertion proves the row
  exists; it does not prove the client can see it. One line in the kiosk console —
  `Object.keys(records).filter(k => k.startsWith('ZZ WALK'))` — would have caught this before the
  first boot.
- **A silent no-op is a defect in its own right**, and it is the exact inverse of the fail-open rule
  ("a man always gets to punch and the owner gets TOLD"). The sweep's per-worker skip paths tell
  nobody: not the console, not `notifLog`, not the health banner, which surfaces only whole-list
  failure and workers *absent* from the skip list. A worker silently exempted is invisible on every
  surface.

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
