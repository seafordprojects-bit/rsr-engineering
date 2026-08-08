# AWOL case lifecycle — design spec

**Date:** 2026-07-29
**Status:** DRAFT — for owner review. No code written.
**Supersedes:** the suspension model in `2026-07-24-awol-suspension-flow-design.md` and the
two-step gate in `2026-07-26-dashboard-reinstate-flow-design.md`. Those stay valid as the
*decision* mechanism; this spec changes what happens *before* a decision, and removes the
automatic kiosk lockout entirely.

---

## 1. What this changes, in one paragraph

Today, three absent working days automatically suspends a man and blocks him at the kiosk on
every tablet, before any human has looked at the case. This spec replaces that with a **case
file**: detection opens a case and tells the office, and nothing else happens to the worker
automatically. A Notice to Explain is issued, served by hand, and he has five calendar days from
the day it was *served* to answer. Only after a human decision can anything block him. The kiosk
stops being the enforcement point.

---

## 2. States

```
Detected ──► NTE issued ──► Served ──┬──► Explanation received ──► Decision ──► Closed
                                     └──► Lapsed ─────────────────► Decision ──► Closed
```

| State | Set by | Means |
|---|---|---|
| `detected` | system (automatic) | 3 absent working days found. Office notified. **Worker unaffected.** |
| `nte_issued` | admin, PIN | The NTE document exists and is dated. Not yet in the man's hands. |
| `served` | admin/clerk, PIN | Physically handed over. **Starts the 5-day clock.** |
| `explanation_received` | admin/clerk, PIN | He answered. Date, receiver and photo recorded. |
| `lapsed` | system (derived) | Five calendar days passed from `served_date` with no explanation. |
| `decision` | admin, PIN | Owner/admin has ruled. The only state that may restrict kiosk access. |
| `closed` | admin, PIN | Case finished and archived. |

Two states are **derived, never stored as a fact by a background job**: `lapsed` is computed from
`served_date` and today's date every time the case is read. Nothing runs at midnight to "lapse" a
case. This matters — a cron that mutates a man's case while nobody is watching is exactly the kind
of silent state change that has bitten this system before.

`detected` and `lapsed` are the only transitions that happen without a PIN, and **neither of them
touches the worker.**

---

## 3. The two clocks, and why they count differently

This is the part most likely to be got wrong later, so it is stated explicitly.

### The 3-day absence count SKIPS Sunday
Sunday is a rest day. A man who does not punch on Sunday has not been absent — he had nowhere to
be. The existing rule at `kiosk/index.html:2260-2272` is correct and is kept unchanged: a Sunday
is transparent, it neither counts toward the three nor breaks the chain.

> **Worked example.** He last works Friday 3 July. He is absent Mon 6, Tue 7, Wed 8.
> Sunday 5 July is skipped entirely. The case opens on Wednesday 8 July with
> `absent_dates = [6 Jul, 7 Jul, 8 Jul]`.

### The 5-day explanation window does NOT skip Sunday
It is five **calendar** days from `served_date`. Sunday is included and consumes a day.

> **Worked example.** Served Thursday 9 July. Day 1 is Friday 10, day 2 Saturday 11,
> **day 3 Sunday 12** — it counts — day 4 Monday 13, day 5 Tuesday 14.
> The deadline is end of **Tuesday 14 July**. The day-6 draft becomes available
> Wednesday 15 July.

Because the two clocks disagree on Sunday, they must never share a helper function. Two separate,
separately-named SQL functions, each documenting which rule it implements:

- `awol_count_absent_workdays(code, upto)` — skips Sunday.
- `awol_explanation_deadline(served_date)` — `served_date + interval '5 days'`, no skipping.

Both live in SQL, not JavaScript, so there is one authority. The kiosk's current JS counter stays
only as a display convenience and loses all authority over the man's access.

---

## 4. `issued_date` and `served_date` are different columns

They are separated because they answer different questions and because the gap between them is
itself evidence.

- `issued_date` — the date on the face of the document. When the office decided to act.
- `served_date` — the date it was physically handed over, with a named `served_by`. **The only
  date the 5-day clock reads.**

`served_date` is nullable. A case can sit in `nte_issued` indefinitely — a man who cannot be found
is not on a clock. **The clock cannot start by accident**, because `served_date` only ever gets
written by an explicit PIN-gated action where a named person states they handed it over.

Backdating is allowed (he was served on Saturday, the office recorded it Monday) but constrained:
`served_date` may not be earlier than `issued_date`, and may not be in the future. Both are
enforced in the RPC, not the UI.

---

## 5. The NTE narration of facts

**OWNER-REQUIRED 2026-07-29: the narration reads actual per-man delivery status from the ledger and
says only what is true for that man. It may never assume he was notified.**

For each absent date, the NTE looks up that man's row in `alert_deliveries` (see Part 4 of the
SMS/Telegram spec) and renders the sentence matching that row's real status — **never a generic
"you were notified"**, and never a claim inherited from another worker's outcome.

| Ledger status | What the NTE says |
|---|---|
| `delivered` | On 26 July 2026 you were absent. A text notice was sent to 0953-099-3211 and was delivered. |
| `failed` | On 26 July 2026 you were absent. A text notice was attempted to 0953-099-3211 and **did not reach your phone**. |
| `no_phone` | On 26 July 2026 you were absent. **No notice could be sent — there is no phone number on file for you.** |
| `suppressed` | On 26 July 2026 you were absent. **No text notice was sent.** |
| `queued` (unsettled) | On 26 July 2026 you were absent. A text notice was sent to 0953-099-3211; **delivery is unconfirmed**. |
| **no row at all** | On 26 July 2026 you were absent. **No notice was attempted.** |

The last row is the one that protects the whole document. A missing ledger row must render an
explicit "no notice was attempted" line — **it may never be silently omitted**, because an absent
line reads as though nothing needed saying, and the reader then infers the man was warned. Absence
of evidence gets stated, not skipped.

Two consequences follow, and both are deliberate:

- **The NTE is honest about the company's own failures.** If the texts did not arrive, the document
  says so. That is a real cost, and it is smaller than the cost of a dismissal built on a written
  claim that turns out to be false.
- **A man with no phone can still be processed.** `no_phone` is a truthful line, not a blocker. He
  was still absent; the company simply could not text him, and says so.

### Why this replaces the earlier blocker

The earlier draft treated the state of `sms_log` as a gate on building anything. Verified
2026-07-29: **106 rows, 0 delivered, 0 successes ever**, sending at 17:00 Manila rather than 3 PM.
That is no longer a blocker, because the narration no longer asserts anything the ledger cannot
prove — a system that has never delivered a message simply produces an NTE that says no notice
reached him, which is exactly what happened.

Fixing the sending path is still worth doing, and is specced separately behind a default-off flag.
The NTE is correct either way, before or after.

---

## 6. "Explanation received" — PIN-gated admin action

A single action recording three things plus the case link.

| Field | Required | Notes |
|---|---|---|
| `explained_on` | yes | Date he answered. May be backdated; may not precede `served_date`; may not be future. |
| `received_by` | yes | Named person who took it. Not "Admin" — a person. |
| `photo` | yes | Photograph of the written explanation. |
| `note` | no | Free text, e.g. "verbal, written up by the coordinator". |

**Accepted after the deadline.** If he answers on day 7, it is still recorded, and the case shows
both the lapse and the late explanation. The system's job is to record what happened, not to
refuse evidence. The decision-maker sees both facts and rules accordingly.

**Photo storage.** Supabase Storage, private bucket `awol-explanations`, path
`<case_id>/<timestamp>.jpg`. Path stored on the case; the image is never inlined into the page or
the Telegram alert. This absorbs the queued
`awol-letter-photo-archival-queued` item — the same mechanism serves the paper AWOL letter and the
written explanation, so it is built once here.

**Fail-closed on the write, fail-open on the man.** If the photo upload fails, the action is
refused and nothing is recorded — a half-recorded explanation is worse than none. But a refused
upload never affects his kiosk access, because at this stage nothing is blocking him anyway.

---

## 7. The day-6 draft that is never sent

From the day after the deadline, a case in `lapsed` exposes a **draft** non-submission letter.

- **Generated on read.** It is rendered from the case when someone opens it. It is not written to
  a table, not queued, not scheduled.
- **There is no send path.** No Telegram call, no SMS call, no email. The only outputs are the
  screen and the printer. This is a deliberate structural guarantee: you cannot accidentally
  configure it to send, because nothing that could send it is wired to it.
- The office prints it, signs it, and serves it by hand — the same as the NTE.
- Producing the draft changes no state. The case stays `lapsed` until a human records a decision.

The daily Telegram digest (§8) mentions that a draft is available. It does not attach it.

---

## 8. No kiosk lockout at any automatic step

**This removes existing live behaviour.** Both blocks are deleted:

- `kiosk/index.html:2049` — the PIN-entry block. Today this blocks *everything*, including Time
  Out, so a man cannot even close an open shift.
- `kiosk/index.html:2801` — the Time In block.

After this change, `detected`, `nte_issued`, `served` and `lapsed` have **zero effect on the
kiosk**. He punches normally throughout. The company's response is paper and conversation, not a
locked screen.

Only a recorded `decision` may restrict access, and only when the decision says so. The decision
itself remains the two-role PIN-gated action already built and tested
(`awol_admin_decide`, 13/13 smoke passing).

How the office learns instead — all of it push, none of it blocking:

1. **On detection** — Telegram to the AWOL group: name, yard, the three dates, and a link to the case.
2. **Daily digest** — every open case, its state, and days remaining on any running clock.
3. **Dashboard card** — the existing AWOL card gains the case states.

This is the fail-open principle applied literally: a man always gets to punch, and the owner gets
told instead.

---

## 8a. The day-3+ kiosk notice — what replaces the lockout

**OWNER-SPECIFIED 2026-07-30.** §8 says what the kiosk stops doing. This says what it does instead.

### The change

Day 3+ no longer auto-suspends and no longer locks anyone out. Instead, **after a flagged man's
punch has been ACCEPTED**, he sees a notice he can dismiss:

```
PAHIBALO — AWOL WARNING

Absent ka og 3 o kapin pa ka adlaw nga sunod-sunod nga walay approved nga leave.
Kuhaa ang imong AWOL letter sa coordinator ug sulati kini inig break, dayon iuli sa coordinator.
Makapadayon ka sa pag-punch ug pag-trabaho samtang gi-proseso ang imong kaso.

                    [ OK — SIGE, PADAYON ]
```

Once per day, on his first punch. **Never blocking.**

The suspension modal (`kiosk/index.html:2049`) stays, and fires **only for men who are actually
suspended** — i.e. after a recorded human decision. The two can never collide: a suspended man is
stopped at PIN entry and never reaches a punch, so he never reaches this notice.

### Why this is the most important notification channel the company has

This is not a lesser substitute for the SMS. It is **better evidence**, and the lifecycle should
treat it as the primary channel:

- The SMS channel has **never delivered a single message** — 106 attempts, 0 delivered (§5).
- Telegram reaches the office, not the worker.
- The NTE is paper and requires finding him.
- **This notice reaches the man himself, at the moment he is standing at the tablet, and his
  dismissal is capturable.**

So the acknowledgement is recorded — timestamp, device, code — and **the NTE narrates it** exactly
as it narrates SMS delivery (§5). A line reading *"On 30 July 2026 at 08:02 you were shown the AWOL
warning at the Carmen kiosk and acknowledged it"* is worth more in a dismissal file than any number
of unsent texts. It is a fact with a timestamp and a device behind it.

This makes `alert_deliveries` (Part 4 of the SMS/Telegram spec) gain a `channel = 'kiosk_notice'`,
with `delivered` meaning *shown and acknowledged*. Same ledger, same NTE narration table, one more
channel — and the only one with a confirmed audience.

### When it fires — and the four carve-outs

Fires when a man is **flagged and not suspended**: an open case in `detected`, `nte_issued`,
`served` or `lapsed`. It does NOT fire for:

1. **Pakyaw** — never counted, never flagged, never noticed (§9a).
2. **Unknown employment type** — the tablet could not classify him, so it never judged him; it must
   not warn him either. It reports to the office instead.
3. **A HOLD (pending leave overlapping an absent date).** This one matters most. His leave may yet
   be approved, in which case those days were never absences. Telling him to fetch an AWOL letter
   would be alarming and possibly wrong. **HOLD means we do not know yet, so we say nothing to
   him** — the office is told, he is not.
4. **A closed or decided case.** Nothing is pending, so there is nothing to prompt.

### Placement in the punch flow — the ordering is the whole safety property

**AFTER the punch is written and confirmed. Never before, never as a gate.**

1. Punch validated and recorded (unchanged).
2. Normal success feedback shown (unchanged).
3. *Then* the notice, as a separate dismissible modal.

If step 3 throws, is skipped, or the modal fails to render, **the punch has already happened**. The
notice can never delay, alter or prevent a punch, and no failure in it can cost a man his pay. That
ordering is not a convenience — it is the reason this design is safe, and it must not be
"tidied" into a single pre-punch check later.

### Once per day

A per-tablet, per-worker, per-day marker in localStorage, cleared by the midnight reset alongside
the other daily state.

**Deliberately per-tablet, not global.** A man who punches at Carmen in the morning and Mandaue in
the afternoon may see it twice. That is the correct trade: seeing it twice is mildly repetitive,
whereas seeing it *zero* times because another tablet had already shown it would mean the company
believes he was warned when he never was. **When in doubt, show it** — it costs nothing, because it
does not block.

Owner question (§10 H): confirm per-tablet is acceptable, or specify once-per-day-globally, which
needs a server round trip on the punch path and I would rather not put there.

### The race must be fixed first — this notice inherits it

`checkAllAbsences()` fires 3s after load; `initSupabaseSync()` starts at 2s and awaits four network
calls in series, with `loadLeavesFromSupabase()` second (`kiosk/index.html:5236`, `:5666`). The
sweep routinely runs before leave data has arrived, so `hasPending` is false and the HOLD carve-out
silently does not apply. Confirmed live 2026-07-30: a staged pending leave failed to hold.

Today that race causes a **wrongful suspension**. Under this design it causes a **wrongful warning**
— strictly less harmful, but it would tell a man with a pending leave to fetch an AWOL letter, and
that lands in his file as a notice he should never have been given.

**Prerequisite: the sweep must await the leave load, and must skip rather than judge when leave data
has not arrived.** Independent of this spec, needed either way.

## 9. Data model (technical — my decisions, not asking)

New table `awol_cases`, one row per incident, so a man can have several over time and each keeps
its own dates, photos and decision. `employee_suspensions` keeps its current job — recording an
*active restriction* — and is written only by a decision, never by detection.

```
awol_cases
  id                uuid pk
  employee_code     text        -- matched on code_norm everywhere, never raw
  state             text        -- check constraint, the seven states above
  absent_dates      jsonb       -- ISO strings, from the Sunday-skipping counter
  detected_at       timestamptz
  issued_date       date
  served_date       date        -- nullable; the ONLY input to the 5-day clock
  served_by         text
  explained_on      date
  received_by       text
  explanation_photo text        -- storage path, not a URL
  decision          text        -- nullable until decided
  decided_by        text
  decided_at        timestamptz
  closed_at         timestamptz
```

Every transition is a `security definer` RPC that verifies the passcode **inside** the function
before anything else, because the anon key is published in `supabase.js`. No client-side table
writes. Each RPC appends to `awol_events` — the existing audit table — with new event names
(`case_opened`, `nte_issued`, `nte_served`, `explanation_received`, `decided`, `closed`).

Dates: all comparisons go through the existing `leave_try_date()` parser, never raw string
comparison. That bug has already cost this system an entire broken absence chain.

---

## 9a. PEM (pakyaw) exemption — total, visible, and dated

**OWNER-REQUIRED 2026-07-29.**

### The exemption is total

A PEM worker is **never counted, never texted, never given a case, never given an NTE.** Not
counted-then-filtered — the absence counter must not accumulate dates for him at all, so there is
no partial state anywhere that a later change could accidentally act on.

Concretely, an exempt man never reaches: `awol_count_absent_workdays()`, `sendAbsenceSMS()`,
`awol_cases` (no row is ever created), or the NTE generator. He is also absent from
`alert_deliveries` entirely — not even as `no_phone`, because no notice is *owed*, so recording a
non-delivery would misrepresent an obligation that does not exist.

### But he is visible, never silently skipped

**The dashboard shows every exempt man, labelled `exempt — PEM`.** A worker who quietly vanishes
from a screen is indistinguishable from one the system forgot, and "he wasn't on the list" is not
something anyone should have to reason about during a dismissal.

This coexists with the existing rule and must not break it: exempt men are **shown as exempt** in
the AWOL roster view, and remain **absent from the manual-suspension dropdown** (`home.js:577`
already filters them; `tests/awol-dashboard/dashboard-awol.smoke.mjs` asserts it — that assertion
stays green). Visible as a status, unselectable as a target.

### Conversion PEM → regular: a hard floor, no looking back

On conversion the absence count **starts fresh from his first day as a regular worker and never
looks back at PEM-period absences.** A man who missed days while on pakyaw carries none of it
across; those days were not absences under a rule that applied to him.

This is enforced by a **date floor, not by hoping the history is empty**: the counter refuses to
consider any date earlier than the conversion date, full stop. If he converts on 3 August and is
absent on 4, 5 and 6 August, the case opens on 6 August with exactly those three dates. Nothing
from July is reachable, whatever the attendance table contains.

### The blocker: exemption is a string prefix in SEVEN places

**OWNER-CONFIRMED 2026-07-29: the code stays. Every screen label and report reads
`employment_type`, never the prefix. A converted man displays as regular even though his code
still reads `PEM`. All seven sites below are replaced — leaving even one re-exempts him silently.**

There is **no employment-type column** on `employees` (verified live — `code`, `name`, `dept`,
`position`, `shift`, `home_site`, … nothing indicating pakyaw). Exemption is inferred from the code
text in **three independent implementations** feeding **five behavioural decisions**:

| # | Site | What it does | Replacement |
|---|---|---|---|
| 1 | `kiosk/index.html:2236` | `isPemCode()` — `/^PEM/`, stripped + uppercased | **delete**; read `employment_type` from the roster row |
| 2 | `kiosk/index.html:2295` | detection skip in `checkAllAbsences()` | call the new single check |
| 3 | `awol-reinstate-flow.sql:71` | `awol_is_pem()` SQL function | **redefine** to read the column, keeping the name so callers 4–6 need no edit |
| 4 | `awol-reinstate-flow.sql:102` | `employee_suspensions_no_pem` CHECK constraint | re-express against the column; **validate it** (see below) |
| 5 | `awol-reinstate-flow.sql:134` | `awol_set_suspended` — `return false` for PEM | follows from 3 |
| 6 | `awol-reinstate-flow.sql:337` | `awol_manual_suspend` — refuses PEM | follows from 3 |
| 7 | `home.js:577` | inline `/^PEM/i` — a **third copy** of the rule, using neither function | **delete**; read `employment_type` |

Sites 1, 3 and 7 are three separate implementations of the same rule that have to agree. Site 7 is
the dangerous one: it never calls either helper, so a fix applied to 1 and 3 leaves it silently
exempting converted men from the manual-suspension dropdown.

Redefining `awol_is_pem()` in place (site 3) rather than renaming it means sites 4, 5 and 6 are
fixed by that single change — three of the seven close themselves, and no SQL caller can be
forgotten. The function keeps its name and loses its prefix logic.

### Two things the sweep turned up

**No screen anywhere currently shows a worker's type.** The only `Pakyaw` label in the codebase is
`coordinator.js:507` — `<option value="PEM">Pakyaw (PEM)</option>` — which is the *creation*
dropdown that picks a code series, not a display of an existing man. So "every screen label reads
`employment_type`" is mostly **additive**: the labels have to be built, not switched. The
`exempt — PEM` badge on the AWOL dashboard is the first of them, and the roster/staff list should
carry the same badge so the two never disagree.

`coordinator.js:507` must also now **set `employment_type` and `type_effective_from` at creation**,
alongside minting the code. It is the only place the type is chosen.

**Payroll does not distinguish pakyaw at all.** No reference to `PEM`, `pakyaw` or piece-rate
anywhere under `payroll/`. Pakyaw men are paid through `daily_rate` like everyone else. So
conversion is **pay-neutral in code** — flipping `employment_type` changes AWOL behaviour and
nothing about money. If converting a man is supposed to change how he is paid, that is a separate
change and is not in this spec (see §10 G).

**A code prefix cannot express a conversion date, and it actively breaks conversion.** If a
converted man keeps his `PEM 0003` code, every one of those four checks keeps exempting him
forever. If instead he is issued a new `RSR` code, his attendance and payroll history is stranded
under the old one, and "starts fresh" happens by accident — via `hasRecentPunchHistory()` finding
no punches — rather than by rule, with a fuzzy 30-day boundary instead of a date.

**So exemption becomes a dated fact on the employee record:**

```
employees
  employment_type      text   -- 'pakyaw' | 'regular'
  type_effective_from  date   -- the day the CURRENT type began
```

- The exemption check reads `employment_type`, never the code prefix.
- `type_effective_from` is the counter's hard floor.
- All four prefix checks are replaced by **one** function reading these columns. The `PEM` prefix
  stays as a naming convention and loses all authority.
- Backfill is mechanical and safe: the five current PEM codes get `pakyaw`, everyone else
  `regular`, with `type_effective_from` = `started_on` (or the earliest attendance date).

Two related items to settle while here:

- **`employee_suspensions_no_pem` is `not valid`** — the `validate constraint` line is commented
  out at `awol-reinstate-flow.sql:62` and `:422`. It guards new rows but has never been checked
  against existing ones. It should be validated once the backfill lands, and its expression
  switched from `awol_is_pem(code)` to the new column.
- A conversion must write an audit row (who converted him, when, effective from when). The
  conversion date decides whether an absence counts, which makes it a pay-adjacent fact.

**This section is a design; §10 question F is the business half.**

## 10. Owner decisions needed before any of this is built

**A. ~~The text notices have never worked. What should the NTE say?~~ RESOLVED 2026-07-29.**
Answered by design rather than by choosing wording: the NTE reads each man's actual delivery status
from the ledger and states only what is true for him (§5). SMS sending is built behind a
default-off flag and stays dormant until the owner enables it. Neither the lifecycle work nor the
NTE is blocked on fixing Semaphore — the document is correct before and after.

**B. Between detection and decision, is he paid as normal?**
He is no longer blocked from punching, so if he turns up on day 4 he works and earns. Confirm
that is intended — it is a change from today, where he cannot punch at all.

**C. Who is allowed to record "Served"?**
The admin only, or also the AWOL clerk (Jamaica, RSR 0025) who already ticks letters received?
She is the one physically handing papers over.

**D. What happens to a man who is served and then simply returns to work on day 2?**
Does the case continue to a decision anyway, or does his return close it? Today there is no
concept of this, because he could not have returned — he was locked out.

**E. Five days from served_date including Sunday — confirmed?**
Stated in your instruction and specced that way. Flagging only because it is the one rule where
the two clocks deliberately disagree, and someone will later "fix" it thinking it is a bug.

**F. ~~Keep the `PEM` code on conversion, or issue a new `RSR` one?~~ RESOLVED 2026-07-29 — keep
the code.** His history stays continuous under one identity. The consequence, accepted
deliberately: **the code no longer tells you what a man is.** Every screen label and report reads
`employment_type`; all seven prefix-inference sites are replaced (§9a). Anyone reading `PEM` as
shorthand for "pakyaw" will be wrong about a converted man, which is why the labels are mandatory
rather than cosmetic.

**H. The day-3+ notice: once per day per TABLET, or once per day globally?**
Per-tablet is what §8a specs. A man who works Carmen in the morning and Mandaue in the afternoon
would see it twice. Global would need a server round trip on the punch path, which I do not want
there — the punch path is the one thing that must never wait on the network. My recommendation is
per-tablet: a repeated notice is a minor annoyance, a *missed* one means the file says he was warned
when he was not.

**I. Interim behaviour if the exemption work ships before the full lifecycle.**
Main currently ships with kiosk detection DISABLED. Everything else in the `employment_type` work —
the column, `awol_is_pem`, the suspension trigger, the dashboard picker, the unknown-type banner —
functions whether or not the sweep runs. So the exemption fix can ship with detection still off, and
detection can be re-enabled later once §8/§8a and the leave race are done. That decouples "ship the
exemption fix" from "turn detection back on". Confirm which you want; I would ship decoupled.

**G. Should conversion change how he is PAID?**
New, and it follows from the sweep. `payroll/` contains no reference to `PEM`, `pakyaw` or
piece-rate — pakyaw men are paid via `daily_rate` exactly like regular workers. So converting a man
changes his AWOL treatment and **nothing about his pay**. If you expect conversion to also change
his pay basis, say so and I will scope it separately; as specced, it will not.

---

## 10a. UNVERIFIED AT WALKTHROUGH — the kiosk heartbeat write

**Owner-required note, 2026-07-29. Read this before treating the unknown-type alarm as proven.**

`sendHeartbeat()` is localhost-guarded — `if (IS_LOCALHOST) return;` at `kiosk/index.html:5875`,
"never pollute prod kiosk_health from a local walkthrough/test". That guard is correct and stays.
Its consequence is that **the kiosk end of the unknown-type wire cannot be exercised during a
localhost walkthrough at all.**

What WAS tested and is now PROVEN (via `kiosk-health-unknown-type.sql`, owner-verified 2026-07-30,
screenshots taken):
- the dashboard renders a red banner when a FRESH row carries `unknown_type_count > 0`,
- it CLEARS when the count returns to 0 — verified, and verified again after teardown,
- a STALE row (242 min) reads in the past tense — "were not checked … has not reported since" —
  and does not assert the count as a current fact.

Two real defects were found by running it rather than reasoning about it, both mine:

1. **`home.js` selected `kiosk_health` columns explicitly and omitted `unknown_type_count`.** The
   banner could never fire. The first test's "pass" was inaccurate, and worse, the CLEARING test
   passed *spuriously* — an inert feature is always clear. A test that passes because nothing is
   wired is worse than one that fails.
2. **Freshness was judged per SITE, not per DEVICE.** Carmen had four rows: two fresh, one stale
   at 224 min, one dead at ~6 days. The count came from the stale device; the freshness came from
   a live one, so a 224-minute-old fact rendered in the present tense. Fixed by using
   `unknownSeen` (which the first version computed and never used). Mandaue looked correct
   throughout only because it has a single tablet, so site-age and device-age were the same number
   — a single-device yard cannot detect this class of bug.

The lesson worth keeping: **aggregate a fact and its freshness from the same source, or the
freshness is about something else.**

Testable on localhost DESPITE the guard, and therefore not an excuse (verified 2026-07-29):
- that `awolUnknownTypeCount` is set by the sweep — read it in the console after `checkAllAbsences()`,
- that its value equals the number the sweep actually skipped.

What remains genuinely untestable from localhost, and must not be assumed:
- that `sendHeartbeat()` puts `unknown_type_count` on the wire and the row lands in `kiosk_health`.

That is ONE unproven link, not three. Narrowing it matters: a vague "this whole path is unproven"
invites shrugging at it, whereas a single named gap can actually be closed on the first tablet.

**Required on the first real tablet after deploy: read the `kiosk_health` row with the owner's own
eyes.** Not "the banner looked right" — the row itself, `device_id` and `unknown_type_count`
together, queried directly. The banner can be right for the wrong reason; the row cannot.

This is the same rule that caught four wrong assumptions in one day: running the code is not
evidence, and neither is a screen that looks correct. Until that row has been read on a real
tablet, the kiosk half of this alarm is **built but unproven**, and it should be described that
way to anyone relying on it.

## 11. Not in this spec

- Changing the 3-day threshold itself (separate policy question, still queued).
- The PIN pad restyle as a centered modal (queued, cosmetic, independent).
- Migrating punch notifications server-side (the bot token is anon-readable — separate task).
- Anything that would require a tablet reset. Removing the two kiosk blocks does change
  `kiosk/index.html`, so it will require a deploy — but see §8, the change only ever *removes*
  restrictions, so a tablet running the old build is stricter, not looser, than intended. That is
  the safe direction for a staged rollout.
