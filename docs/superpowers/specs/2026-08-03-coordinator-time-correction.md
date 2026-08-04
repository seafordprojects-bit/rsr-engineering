# Coordinator time-correction with admin approval — Design (DRAFT 2026-08-03)

**Status: SPEC ONLY. Nothing built. No source file touched.**
Requires the owner's confirmation before any build. Build starts only **after Friday's payroll
cutoff** (the coming Friday, 2026-08-07 — correct me if the cutoff week differs).

**§12 OPEN QUESTIONS: ALL 8 ANSWERED BY THE OWNER, 2026-08-04.** Each answer is recorded both at the
question in §12 and as a note in the section it governs.
**Two answers overrode the recommendation in this spec:** Q4 (Telegram reminder built NOW, not
later) and Q5 (the date fix is NOT folded in — it is a prerequisite). The other six confirmed the
recommendation, most with an owner addition attached — notably Q1 (the banner must also count
unclosed days), Q7 (the payroll-adjustment route for older errors must be named on screen, not
silently refused) and Q8 (preset rejection reasons, so a required note is one tap).
**Still outstanding before §13 may begin:** the §11 `getAttendance()` date fix must ship first as its
own one-line change (§14, prerequisite).

Jamaica (RSR 0025) gets a times-only correction screen on the coordinator page. Everything she
enters is a **proposal**. The admin approves — one at a time, or a whole day at once — and only an
approval ever changes a punch that payroll reads.

---

## 1. What exists today (read before judging the design)

| Thing | Where it lives now | Relevance |
|---|---|---|
| **Edit-times** (passcode-gated punch editor, the D-correction mechanism) | `payroll/index.html` — `editTimes()` 1180, `renderEditArea()` 1220, `addEditDay()` 1309, **`saveTimes()` 1322**, `loadEditHistory()` 1385 | This is the mechanism the new feature must share or absorb. |
| Passcode gate on save | `openConfirm()` `payroll/index.html:1586`, checks `cfg.pin` | Reused as-is. |
| Append-only edit log | table `attendance_edit_audit`, DDL in `payroll/attendance-edit-audit.sql`; BEFORE UPDATE/DELETE trigger blocks mutation | Reused as the single audit trail. |
| Punch recompute engine | `recomputeDay()` 545, `prSessions()`, `nightND()`, `toISO()`, `milTo24()` — all inside the **classic (non-module) inline `<script>` at `payroll/index.html:301`** | Cannot be imported by `coordinator.js`/`home.js` (those are ES modules). Drives the placement decision in §4. |
| Backfill picker (open Edit-times for a worker with zero rows this week) | `populateWorkerPicker()` 1184, `openWorkerEdit()` 1199 | Becomes the "worker nobody edited" escape hatch (§8). |
| Coordinator page shell + area tiles | `coordinator/index.html`, `coordinator.js` `App()` 1921 | New tile hangs here. |
| Coordinator page lock | `Lock()` `coordinator.js:287` — one **shared** `settings.coordinator_pin`, `sessionStorage rsr_coord` | Page entry only. Not identity. |
| Coordinator read-only attendance view | `Attendance()` `coordinator.js:944`, `getAttendance()` 161 | Closest visual precedent. **Carries a live defect — see §11.** |
| Per-person PIN → named identity | RPC `awol_clerk_for_pin` (`awol-reinstate-flow.sql:224`), flag `employees.is_awol_clerk`, global fail-closed throttle; UI pattern at `coordinator.js:1849` (`AwolLetters`) | The exact template for the named attribution this feature requires. |
| **The anti-pattern being corrected** | `coordinator.js:746` and `:836` write `filed_by:'Coordinator'`; `:220`/`:225` write `decided_by:'Coordinator'` | A generic string. Nobody can tell later *which person* filed it. **This feature must not repeat it.** |

Confirmed from `named-issuer-access.sql:16`: **RSR 0025 = Jamaica L. Batucan (assistant)**, already
`is_issuer = true` and already the sole `is_awol_clerk` (`awol-reinstate-flow.sql:405`). She has an
`employees.pin` today.

---

## 2. Named attribution — the core rule

Every pending edit stores **`filed_by_code` + `filed_by_name`**, resolved from the PIN she types at
submit. Never a role string.

New RPC **`time_editor_for_pin(p_pin text) returns jsonb`**, copied structurally from
`awol_clerk_for_pin`:

- keyed on a new flag `employees.is_time_editor` (NOT `is_issuer`, NOT `is_awol_clerk` — those grant
  unrelated powers and must not silently confer this one);

> **OWNER DECISION 2026-08-04 (§12 Q6): Jamaica (RSR 0025) alone at launch.**
> **Adding a second time editor later is a FLAG FLIP, NOT A BUILD.** It is one `update employees set
> is_time_editor = true where employee_code = '…';` — no code change, no deploy, no stamp bump, no
> walkthrough. Anyone with a working employee PIN becomes an editor the moment the flag is set, and
> removing it revokes access just as immediately. So if Jamaica is out sick, cover is a one-line SQL
> statement on the day, not a scheduled piece of work. This is deliberate: the launch roster is a
> business decision the owner can change at will without waiting for engineering.
- returns `{ok:true, code, name}` or `{ok:false}` — never the PIN, never a reason;
- same **global fail-closed throttle** (own single-row table, 10 fails → 15-minute lock, locked state
  indistinguishable from a wrong PIN);
- `security definer`, `set search_path = public`, granted to `anon, authenticated`;
- seeded by **normalized code** `RSR0025` (upper-case, whitespace stripped), same as the issuer seed.

The page lock (shared `coordinator_pin`) stays as page entry. Identity is proven at **submit**, per
submission — exactly like `AwolLetters`. Adding a second time editor later = flip one flag, no code
change.

**Residual, stated not fixed:** `employees.pin` is stored in plaintext and compared with `e.pin =
p_pin`, same as `issuer_for_pin` and `awol_clerk_for_pin`. This feature inherits that; hardening the
employee-PIN store is its own job across all three RPCs.

---

## 3. Data model

### 3.1 New table `attendance_time_edit` — the pending queue

One row per **worker-day per submission**.

| column | type | note |
|---|---|---|
| `id` | bigint identity PK | |
| `employee_code`, `employee_name` | text | name denormalized so the queue reads without a roster join |
| `date` | text | **same mixed TEXT format as `attendance_records.date`** — never a range filter on it |
| `attendance_id` | text/uuid null | the existing row's id; **NULL = no kiosk row exists for that day** (the pure missing-day case) |
| `before` | jsonb | the six punch values as they stood at submit (`{timein,lunch_out,lunch_in,pm_out,pm_in,timeout}`) |
| `after` | jsonb | what the coordinator proposes |
| `reason` | text not null | required, same rule as Edit-times |
| `status` | text | `pending` · `approved` · `rejected` · `superseded` |
| `filed_by_code`, `filed_by_name` | text not null | **from the PIN, never a role** |
| `filed_at` | timestamptz default now() | |
| `decided_by_code`, `decided_by_name`, `decided_at` | text / timestamptz | admin side |
| `decision_note` | text | optional; required on reject |
| `applied` | jsonb | what was **actually written** — equals `after` on a plain approve, differs when the admin corrected first |
| `batch_id` | uuid null | set when approved through a bulk day approve |

Unique partial index on `(employee_code, date) where status = 'pending'` — one live proposal per
worker-day. Re-editing the same worker-day before approval **updates** the open pending row (and its
`after`), it does not stack a second one.

`attendance_time_edit` is a **workflow table, not the audit trail** — it may be updated (status,
decision). The immutable record stays `attendance_edit_audit`.

### 3.2 `attendance_edit_audit` — additive columns, still the one audit trail

Additive and nullable, so the append-only trigger and every existing reader keep working:

- `source` text — `owner-direct` | `coordinator-approved` | `admin-corrected`
- `filed_by_code`, `filed_by_name` text — who *proposed* it (null for `owner-direct`)
- `edit_id` bigint — back-pointer to `attendance_time_edit.id`
- `batch_id` uuid — same value across every item of one bulk approve

`actor` keeps its meaning: **who applied it**. Existing rows stay valid and unchanged.

### 3.3 New table `attendance_day_lock` — the one-way flow

`date` text PK, `locked_at`, `locked_by_code`, `locked_by_name`. Presence of a row = the coordinator
can no longer edit that day (§9).

---

## 4. Where each surface lives, and why

**Admin approval queue = a new tab in `payroll/index.html`** ("Time approvals"), beside Run Payroll /
Today / Cash Advances / Settings.

This is forced by the "one edit path" constraint, not by preference. Applying an approval means
writing punches *and recomputing* `worked_ms`, `ot_ms`, `is_late`, `is_incomplete`, `status` — that
engine (`recomputeDay`/`prSessions`/`nightND`) lives in the classic inline script of
`payroll/index.html` and is not importable by the `home.js` ES module. Putting the queue in the
dashboard would mean a second copy of the pay math: precisely the two-paths outcome the constraint
forbids. Re-implementing it in PL/pgSQL would be a third copy. So the queue sits where the engine is.

`home.js` (RSR Admin dashboard) may carry a **read-only count badge** linking to the payroll tab —
cheap, no logic duplicated. Optional; I'd include it.

**Coordinator surface** = a new tile on the `coordinator.js` landing grid, "🕒 Time correction —
fix or fill missing clock times · admin approves". It **writes only to `attendance_time_edit`**.

### The invariant that makes "one edit path" checkable

> **Punch columns of `attendance_records` are written in exactly one place: `payroll/index.html`.**
> Nothing in `coordinator.js` or `home.js` ever writes `timein / lunch_out / lunch_in / pm_out /
> pm_in / timeout`. Grep-verifiable at review.

### How Edit-times and the new path merge

`saveTimes()` (1322) is refactored — behaviour unchanged — into a shared internal
`applyPunchEdit(rows, {reason, actor, source, filedBy, editId, batchId})` that does what `saveTimes`
already does today:

1. diff `before` → `after` per day, drop unchanged days;
2. **log first** — insert `attendance_edit_audit` rows; a failed log aborts before anything is
   written;
3. `update` / `upsert` `attendance_records` (`onConflict:'employee_code,date'` for a new day);
4. `runPayroll()` to recompute.

Three callers, one function:

| caller | `actor` | `source` |
|---|---|---|
| existing Edit-times modal (owner direct — the D-correction path) | `owner` | `owner-direct` |
| approve a coordinator edit | `owner` | `coordinator-approved` |
| admin corrects then approves | `owner` | `admin-corrected` |

The owner's existing Edit-times workflow is **unchanged from the owner's side** — same modal, same
required reason, same passcode, same "Past edits" panel. The one visible difference: the panel now
also shows *who proposed* an edit when it came through the coordinator.

---

## 5. Coordinator screen (times only)

- Pick a **date**; optionally step across the pay week. Payroll-like table, one row per worker.
- Six punch cells per worker (`Time In · Lunch Out · Lunch In · PM Out · PM In · Time Out`),
  24-hour/military entry, identical formatting rules to Edit-times.
- **No rate, no hours-to-money, no allowance, no vale, no net — nowhere on this screen.** Worked
  hours may be shown as hours (h), since she is correcting time and needs to see the effect; peso
  values never appear. *(Flagged in §12 — if even the hours total is too much, say so.)*
- "Add a missing day" for a worker with no kiosk row at all → row with `attendance_id = NULL`.
- Required **Reason** per submission. Blank = blocked, same rule as Edit-times.
- **Submit** → PIN prompt → `time_editor_for_pin` → on `ok:true`, upsert the pending row(s) with her
  code and name. Her name is shown back to her on the confirmation ("Sent to the admin — filed by
  Jamaica L. Batucan").
- Each row shows its own state: `— · PENDING (waiting for admin) · APPROVED · REJECTED (reason) ·
  LOCKED (approved day, admin only)`.
- **Data fetch:** fetch broadly and filter client-side with a `toISO()` normalizer. `date` is TEXT in
  mixed `MM/DD/YYYY` and `YYYY-MM-DD` forms; `.eq('date', …)` and gte/lte silently drop rows.

She cannot: delete a record, change a name/code/site, touch anything on an approved-and-locked day,
or see money.

> **OWNER DECISION 2026-08-04 (§12 Q7): reachable window = the CURRENT pay week, plus the PREVIOUS
> week only until Friday's cutoff. Nothing older, ever, on this surface.**
> Once Friday's cutoff passes, the previous week closes to her too — the date stepper refuses to go
> back past the window and dates outside it are not merely read-only, they are not offered.
>
> **Older errors are still fixable — through a different door.** An error found on an already-paid
> week does NOT become a punch edit; it goes to the owner as a **payroll adjustment**
> (`payroll_adjustment`, append-only, `payroll/adjustments.html` — see the standing adjustments
> workflow). Reason: rewriting a punch on a week whose payslips are already printed and paid does
> not correct anyone's pay, it only makes the attendance record disagree with the money that was
> actually handed out. The adjustment route corrects the money and leaves both records honest.
>
> The coordinator screen must say this plainly rather than silently refusing — when she lands on a
> date outside the window: *"This week is already paid. Report it to the admin — it is fixed as a
> pay adjustment, not a time edit."*

---

## 6. Admin approval queue

Only worker-days with a **pending** edit appear (§8).

Per item, two rows stacked, differences obvious at a glance:

```
Sabado, Ricky · RSR 0031 · 07/31/2026            filed by Jamaica L. Batucan · 6:12 PM
             In      L-Out   L-In    PM-Out  PM-In   Out
ORIGINAL     08:03   12:01   12:58   —       —       —
EDITED       08:03   12:01   12:58   —       —      17:04     ← changed cell highlighted
Reason: "forgot to punch out, confirmed with foreman"
[ Approve ]  [ Correct & approve ]  [ Reject ]
```

- Unchanged cells rendered dim; changed cells highlighted. Blank shown as `—`, never as empty space.
- **Approve** → passcode → apply via `applyPunchEdit` with `source='coordinator-approved'`.
- **Correct & approve** → the cells become editable inline, admin adjusts, then approve;
  `source='admin-corrected'`, `applied` records what actually landed, and the item is **excluded from
  any bulk action** (§7).
- **Reject** → `decision_note` required; nothing touches `attendance_records`.

> **OWNER DECISION 2026-08-04 (§12 Q8): a note is REQUIRED — but it is normally one tap, not typing.**
> The reject control offers four preset reasons as buttons, plus a free-text field:
>
> - `He was on approved leave`
> - `Punch is correct as recorded`
> - `Wrong worker`
> - `Wrong date`
>
> **A tapped preset IS the note** — it is stored in `decision_note` as that literal sentence, so the
> coordinator sees a real reason and the record reads the same whether it was tapped or typed. Free
> text stays available for anything the presets don't cover, and a preset may be tapped and then
> edited. What is NOT allowed is a bare reject: no preset and no text = the Reject button stays
> disabled.
>
> Rationale (owner): rejecting eight rows on cutoff day must be eight taps, not eight typed
> sentences — a forced free-text field on a busy Friday collects "no" and "wrong", which teaches the
> coordinator nothing and is worthless six weeks later. Presets keep the notes meaningful precisely
> BECAUSE they are the low-effort path.
>
> Store the preset text verbatim, not a code — the note is read by humans and must survive any
> future change to the preset list without turning old rejections into orphaned identifiers.
- **Admin direct edit** (a worker-day with no coordinator edit) stays the existing Edit-times modal —
  self-approved, still logged, `source='owner-direct'`.

### Conflict guard (kiosk sync lands after the coordinator typed)

Kiosk punches sync on a 30-second retry queue, so `attendance_records` can move between submit and
approve. At approve time the current row is re-read and compared to the edit's `before`. If any punch
field drifted, the item is marked **CONFLICT — the kiosk sent a punch after this was filed**, shows a
third row (`NOW`), is **removed from the bulk set**, and must be handled individually. Never silently
overwrite a real punch with a stale proposal.

---

## 7. Bulk approval — per day

Strictly one day. There is no multi-day approve, and no "approve everything pending".

1. Admin selects **one date**. The queue shows that day's pending items only.
2. Admin works down the list: reject what's wrong, "correct & approve" what needs adjusting. Each of
   those leaves the bulk set the moment it is handled.
3. **`Approve remaining (N)`** → confirmation before anything is committed:

   > **Approve 11 time corrections for 07/31/2026?**
   > 11 will be approved · 4 excluded (2 rejected, 1 corrected & approved, 1 conflict)
   > Enter passcode to confirm.

4. One passcode entry for the batch (the confirmation already names the scope and counts).
5. Apply: iterate the batch, **each item log-first** — its own `attendance_edit_audit` row with the
   same `employee_code`, `date`, per-field `changes`, `reason`, `actor`, `filed_by_*`, `edit_id`, and
   a shared `batch_id`. Then its `attendance_records` write. Then the next item.

**Bulk is a UI convenience, never one lumped log entry.** A bulk-approved item and an
individually-approved item are indistinguishable in the audit trail except for the presence of
`batch_id`.

**Partial failure is explicit.** There is no cross-item transaction over PostgREST, and moving the
apply into a single SQL RPC would require re-implementing `recomputeDay`/`prSessions` in PL/pgSQL —
a second pay engine, which the "one edit path" constraint rules out. So: on the first item that
fails, the run stops and reports *"Applied 7 of 11. Items 8–11 are still pending — retry."* Every
applied item is fully logged; every unapplied item is untouched and still pending. Log-first per item
means an edit can never land unlogged. Re-running the bulk skips already-approved items.

After a successful bulk approve, the day is **locked** (§9).

---

## 8. The queue lists edited entries only — and the two required routes

**Untouched workers never appear in the queue.** The queue is a list of proposals, not a roster.

### A day with no edits
The tab shows, for the selected date:

> **No time corrections filed for 07/31/2026.** Payroll will use the kiosk times as recorded.

No worker list, no empty rows, nothing to approve, no lock written. Payroll runs on kiosk data — the
normal case, and it must look normal.

### A worker-day that SHOULD have been edited but wasn't
This is the dangerous gap: a missing punch nobody caught. It is **not** left implicit — it gets its
own section directly beneath the queue on the same tab:

> **⚠ Missing punches with no correction filed (N)** — *these are not in the queue; nobody has
> proposed a fix.*

Contents, for the **currently loaded pay week**, excluding any worker-day that already has a pending
or approved edit:

- rows where `is_incomplete` is true;
- rows with a `timein` and no `timeout` (or a `timein` with a lunch/PM session left half-open);
- rows that `prSessions` hard-flags — the days that pay ₱0.

Each entry has one button, **Fix now**, which opens the existing Edit-times modal on that worker-day.
Admin direct edit, self-approved, logged with `source='owner-direct'`.

For a worker who has **no row at all** and therefore cannot be listed by data: the existing backfill
worker-picker (`populateWorkerPicker` / `openWorkerEdit`, already in the Run Payroll tab) opens
Edit-times for any active worker even with zero rows this week. The approvals tab carries a line
pointing there: *"A worker missing entirely? Use 'Pick a worker' on the Run Payroll tab."*

**Deliberately out of scope:** deciding whether a day with no row is a missed punch or a legitimate
absence needs a cross-check against leave / reported-absence / AWOL data. That is §12 open question 3.

> **OWNER DECISION 2026-08-04 (§12 Q3): (a) now, (b) as its own item — with a binding constraint.**
> The AWOL detector ALREADY sees the never-punched case; that is precisely what it counts. When (b)
> is built it MUST read from the detector's existing logic, not define "absent" a second time. Two
> independent definitions of an unexplained absence would drift and eventually disagree about the
> same man on the same day — one screen flagging him, the other not. Whatever the detector treats as
> an explained date (approved leave, reported absence, Sunday skipping) is what this list must treat
> as explained, by calling the same code path rather than re-implementing the rules.

---

## 9. One-way flow and the day lock

- Pending edits never touch `attendance_records`. **The original value is what applies until an
  approval lands.**
- On approval, the punch is written, `attendance_edit_audit` records it, the edit row goes
  `status='approved'` with `decided_by_*` and `applied`.
- **Locking:**
  - an **individual** approve locks **that worker-day** — the coordinator sees it as `LOCKED` and can
    no longer edit that worker on that date;
  - a **bulk day approve**, or an explicit **"Close day"** button, writes `attendance_day_lock` for
    the whole date — the coordinator's entire view for that day goes read-only.
  - **CONFIRMED by the owner 2026-08-04 (§12 Q1): an individual approve freezes ONLY that worker.**
    Approving Ricky's Friday leaves the other four men on Friday fully editable. The whole day
    freezes only on "Approve remaining" or an explicit "Close day".
  - **Consequence the owner explicitly wants covered:** because nothing closes a day implicitly, a
    day can end up with every item approved and still never be CLOSED. That state must be visible —
    see the banner rule in §10. An approved-but-unclosed day is not a finished day.
- After a lock, the day is **admin-only**: Edit-times still works, still logged, forever.
- A locked day the coordinator opens shows: *"Approved and locked. Ask the admin for any further
  change."*

---

## 10. Payroll

- **Payroll reads approved data only — structurally, not by a filter.** Pending edits live in a
  different table and never reach `attendance_records`, so `runPayroll()` (809) and its fetch (829)
  need no change at all. Nothing pending can leak into a payslip.
- **Warning banner** on the Run Payroll tab, above the results:

  > **⚠ 6 pending time corrections in this pay week (07/27 – 08/02).** They are NOT in this payroll.
  > **[ Review → ]**

  Counted from `attendance_time_edit where status='pending'`, fetched broadly and filtered
  client-side by `toISO()` against `curFrom`/`curTo` — never a range filter on the TEXT `date`.
- Banner refreshes with the existing 30-second live auto-refresh poll (`_live`, 1445).

> **OWNER DECISION 2026-08-04 (§12 Q1 addition): the banner counts TWO things, not one.**
> Because an individual approve freezes only that worker (§9), a day can reach cutoff with every
> item approved and still never have been closed. The owner must be able to SEE that. So:
>
> 1. **pending items** — `attendance_time_edit where status='pending'` in the loaded pay week; and
> 2. **unclosed days** — any working date in the loaded pay week that HAS coordinator activity but
>    NO `attendance_day_lock` row.
>
>  > **⚠ 6 pending time corrections in this pay week (07/27 – 08/02).** They are NOT in this payroll.
>  > **⚠ 2 days not closed: Fri 08/01, Sat 08/02.** Every correction on them is approved, but the
>  > day was never closed.
>  > **[ Review → ]**
>
> Each half appears only when non-zero, and the second half must appear **even when pending = 0** —
> that is the entire point of the addition. **No banner at all only when pending = 0 AND unclosed =
> 0.** (Supersedes the older blanket "Zero pending → no banner" rule.)
>
> The same two conditions drive the cutoff-day Telegram reminder (§12 Q4) — one definition of
> "outstanding", used by both surfaces, so the banner and the message can never disagree.

---

## 11. Audit trail visible to the admin

- **`attendance_edit_audit` stays the one immutable record.** Every applied change — owner direct,
  coordinator-approved, admin-corrected, individual or bulk — writes exactly one row per worker-day
  with per-field `old → new`.
- The existing **"Past edits"** panel inside Edit-times (`loadEditHistory`, 1385) is extended to
  render the new columns:
  `07/31/2026 — timeout: — → 17:04 · "forgot to punch out" · filed by Jamaica L. Batucan (RSR 0025) ·
  approved by owner · 08/01/2026 7:14 AM · batch`
- The approvals tab gets a **Decided** section (approved + rejected, most recent first) so an approval
  can be traced without opening a worker's modal.
- Rejections live in `attendance_time_edit` only (nothing was applied, so there is no audit row) —
  but they are visible, with their note, to both the admin and the coordinator.

**Pre-existing defect, adjacent, not fixed here:** `coordinator.js:161 getAttendance()` uses
`.eq('date', dateStr)` with a `MM/DD/YYYY` string — the mixed-format landmine, so the existing
read-only Attendance view silently omits any `YYYY-MM-DD` row. The new screen must not repeat it.
Whether to fix the old view in the same build is §12 open question 5.

> **OWNER DECISION 2026-08-04 (§12 Q5): NOT folded in — it is a PREREQUISITE.**
> `coordinator.js:161 getAttendance()` gets fixed this week as its own one-line change, landing
> **before the time-correction build starts**, not inside it. It is therefore not a task in §13's
> build sequence; it is a gate on §13 beginning at all. Rationale: keeps this feature's walkthrough
> scoped to the feature, and means the Attendance view is already telling the truth before a
> correction screen is put next to it. Use the `toISO()` normalizer — fetch broadly, filter
> client-side — never a `.eq('date', …)` on the raw text column.

---

## 12. Open questions — owner decision needed (plain language)

**1. When an approval locks the coordinator out — the whole day, or just that worker?**
Say Jamaica files corrections for 5 men on Friday. The admin approves Ricky's straight away in the
morning. Should that single approval freeze Friday for *everyone* — so she can no longer fix the
other four — or freeze only Ricky, leaving the other four still editable until the admin approves the
day as a whole?
*My recommendation:* freeze only Ricky. The whole day freezes when the admin taps "Approve remaining"
or "Close day".
**ANSWERED 2026-08-04 — freeze only that worker.** Plus an owner addition: the payroll banner must
also count **unclosed days**, not just pending items, so a Friday that was never closed is visible at
cutoff even when every individual item happens to be approved. See §9 and §10.

**2. Can Jamaica see hours, or only clock times?**
"Times only, no rates" is clear about money. But a corrected day naturally shows a worked-hours total
(e.g. "8.5 h"), which is what tells her the fix looks right. Hours are one multiplication away from
pay for anyone who knows a man's daily rate.
*Options:* (a) show hours per day — she can sanity-check her own correction; (b) clock times only,
no totals anywhere.
*My recommendation:* (a).
**ANSWERED 2026-08-04 — (a), hours per day shown.** She needs the total to catch her own typos, and
she could compute it from the clock times anyway. Rates stay hidden everywhere, **including any
derived pay figure**; the coordinator surfaces must not even FETCH rate columns (a client-side
select of `daily_rate` is readable in devtools whether or not it is rendered). See §5.

**3. Should the "missing punches" list also flag men with NO record at all that day?**
Today the list can only show days that have a row with something wrong. A man who never punched at
all has no row — he is invisible. Listing him means cross-checking leave, reported absence and AWOL
so a man on approved leave is not flagged every single day.
*Options:* (a) leave it — rows-with-problems only, this build; (b) add "absent, no leave filed" using
the existing leave/reported-absence data.
*My recommendation:* (a) now, (b) as its own item — it overlaps the AWOL detector's territory and
deserves its own review.
**ANSWERED 2026-08-04 — (a) now, (b) later.** Binding constraint on (b): it must read the AWOL
detector's existing never-punched logic, never define "absent" a second time. See the note in §8.

**4. Should Telegram announce anything?**
Existing flows notify: AWOL letters, leave decisions, stuck punches.
*Options:* (a) silent — the payroll banner is the only prompt; (b) one message when Jamaica files
("6 time corrections waiting"); (c) a reminder if anything is still pending on cutoff day.
*My recommendation:* (a) for this build, (c) later if things get missed.
**ANSWERED 2026-08-04 — (c) NOW, in this build. Explicitly NOT (b): no per-filing messages.**
One reminder on cutoff day, sent to the **same AWOL group** (`tg_awol_group`), fired if anything is
still pending **OR any day is unclosed** (the Q1 signal, reaching Telegram as well as the banner).
Sent once and only when something is genuinely outstanding — silence means clean, so the message
never becomes noise. Carries a **send-once guard keyed to the cutoff date** so re-running or
re-opening payroll cannot fire it twice (same failure class as the vale double-post). Default send
time Friday morning; owner may retune it to sit closer to the actual payroll run.

**5. Fix the existing coordinator Attendance view's date bug in the same build?**
It currently drops rows stored as `YYYY-MM-DD` (§11). It is a genuine bug, one line, but it is a
separate screen from this feature. Fold it in, or keep this build clean and do it separately?
*My recommendation:* fold it in — same file, same session, and a half-blind attendance view next to a
correction screen is confusing.
**ANSWERED 2026-08-04 — NOT folded in.** Fixed this week as its own one-line change, before this
build starts. It is a **prerequisite / gate on §13**, not a step inside it. See the note in §11.

**6. Is Jamaica the only time editor at launch?**
Seed `is_time_editor` for RSR 0025 alone, or also Alvin (RSR 0005) / Ritchie (RSR 0023) who already
hold issuer PINs?
*My recommendation:* Jamaica alone. Adding another later is one flag flip, no code change.
**ANSWERED 2026-08-04 — Jamaica (RSR 0025) alone at launch.** Alvin and Ritchie are NOT seeded;
holding an issuer PIN must never confer time editing. See the note in §2.

**7. How far back may she reach?**
Only the current pay week, or also last week (which is already paid)?
*My recommendation:* current pay week only, plus the previous week **until Friday's cutoff**. Nothing
older — an already-paid week is a correction-and-adjustment matter, not a punch edit.
**ANSWERED 2026-08-04 — current week + previous week until Friday's cutoff.** Anything older is
STILL FIXABLE, but as a **payroll adjustment**, not a time edit; the screen tells her so by name
rather than just refusing. See the note in §5.

**8. Rejection wording shown to the coordinator.** — **ANSWERED 2026-08-04: required, via 4 preset
buttons + free text; a tapped preset IS the note; bare reject blocked. See the note in §6.**
The admin's note goes back to her verbatim. Should the screen require it (so "no" always carries a
reason), or allow a bare reject?
*My recommendation:* require it.

---

## 13. Build sequence (only after confirmation and after Friday's cutoff)

1. **SQL** — one file, `coordinator-time-correction.sql`, safe + idempotent, `--` comments,
   owner runs it. Leads with the canary read `select count(*) from public.attendance_records;` and
   `select current_database();` per the standing two-project rule; other project's tab closed first.
   Contents: `attendance_time_edit`, `attendance_day_lock`, additive columns on
   `attendance_edit_audit`, `employees.is_time_editor`, `time_editor_for_pin` + its throttle table,
   the RSR0025 seed, grants, `notify pgrst, 'reload schema';`, and a re-query verification block.
   **Verified live before any client work** — one query touching the new objects, per the standing
   "verify SQL is actually applied" rule.
2. **`payroll/index.html`** — refactor `saveTimes` → `applyPunchEdit` (behaviour identical; verify the
   owner's existing D-correction flow first, unchanged), then the Time-approvals tab, the missing-
   punch section, the pending banner, the extended Past-edits panel.
3. **`coordinator.js`** — Time-correction tile + component + PIN submit.
4. **`home.js`** — optional read-only pending count.
5. **Validate** — extract the largest inline `<script>` from `payroll/index.html`, `node --check` as
   an ES module; `node --check` `coordinator.js`; hygiene grep (`wpmcbjrisuyjvobvzaus` present,
   `azfmpleswqixaslvcito` absent); run `tests/kiosk-stress/` if anything touched shared punch math.
6. **Stamps** — `payroll/index.html` `v2026-07-25a` → new stamp **with `preflight.html` EXPECT in
   lockstep** (`preflight.html:45`); bump `coordinator/index.html`'s `coordinator.js?v=` cache-buster.

## 14. Gates

- **This spec requires the owner's confirmation before any code is written.** Open questions in §12
  answered first.
- **PREREQUISITE (owner, 2026-08-04):** the `coordinator.js:161 getAttendance()` date-format fix
  (§11) ships as its own one-line change FIRST. §13 does not start until that is live.
- **Pay-adjacent and interactive on both surfaces → owner localhost walkthrough before any push to
  `main`.** No exceptions, no ambiguous go.
- Walkthrough must cover: file an edit as Jamaica (her PIN, her name shown on the queue item) ·
  wrong PIN refused · approve one · correct-and-approve one · reject one · bulk approve a day with
  exclusions, and confirm the counts in the dialog match · a bulk-approved item and an individually-
  approved item look identical in Past edits apart from the batch marker · a day with no edits reads
  as "nothing to approve" · the missing-punch section finds a real half-open day · the payroll banner
  counts correctly and disappears at zero · a locked day refuses coordinator edits · payroll totals
  before/after an approval move exactly as expected.
- **Build starts only after Friday's payroll cutoff.**
