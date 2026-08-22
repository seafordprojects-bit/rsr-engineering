# Holiday pay

Status: **DRAFT — spec only. No code written. Owner review is gate 1 and nothing starts without it.**

Scope: a `holidays` table, a passcode-gated write path, an admin Holidays section, a Telegram
notice on add/edit, and holiday computation in the weekly payroll. Forward-only from deployment.

---

## 0. Read this part first

Seven questions in §11 are **blocking**. They are not polish — each one changes what a man is paid,
and four of them are not answerable from the brief as written. §10 lists five things already in the
live code that this feature collides with; two of them would mispay on day one if implemented
literally.

Everything else in this document is settled and needs only a yes.

---

## 1. What this is for

Philippine law pays workers on declared holidays whether or not the yard runs that day. Right now
the payroll knows nothing about holidays: a declared holiday is either an ordinary worked day or an
absence, and any holiday pay the owner wants to give is entered by hand as a payroll adjustment.

This feature moves that into the system: the owner records the holiday once, and payroll computes
it for everyone, the same way every week, with the reason visible on screen when a man does not
qualify.

**Non-goals.** Not in this build: automatic import of the national holiday proclamation, holiday
pay for past weeks, per-worker holiday schedules, and any change to how leave, OT, night
differential or the Sunday premium are computed on ordinary days.

---

## 2. The `holidays` table

| column | type | notes |
|---|---|---|
| `date` | date | the holiday itself. Primary key candidate — see below |
| `name` | text | e.g. "Araw ng Kagitingan". Shown on the payroll screen and in the Telegram notice |
| `type` | text | `regular` · `special_nonworking` · `special_working`. CHECK-constrained to that set |
| `scope` | text | `national` · `local`. CHECK-constrained. **See Q6 — scope is recorded but currently drives nothing** |
| `added_by` | text | who recorded it, as a name, the way `voided_by` on `employee_suspensions` works |
| `created_at` | timestamptz | `default now()` |

**A real date column, not text.** `attendance_records.date` is mixed-format TEXT and that is a
permanent landmine in this repo — every read has to fetch broadly and normalise client-side. This
table is new, so it starts clean: `date` is a real `date`. Every comparison against attendance goes
through the existing `att_date_iso()` (already live, added by `coordinator-time-correction.sql`),
which normalises the attendance side rather than corrupting this one.

**Two holidays can fall on one date** (this happens — a special non-working day proclaimed on top
of a regular holiday). Recommend the primary key be `(date, name)` with a separate uniqueness rule
of one *paid* type per date, rather than `date` alone. Technical, mine to decide, flagged only
because it is visible in the UI: it is what decides whether "add" on an occupied date replaces or
stacks.

**Grants.** `select` to `anon` and `authenticated` — payroll and the dashboard both read it.
**No `insert`, `update` or `delete` to anyone**, exactly as `attendance_day_lock` revokes `update`.
The only door is the RPC in §3, and a table anon can write directly is not gated at all.

---

## 3. The write path — one passcode-gated RPC

Modelled on `awol_void_case()` in `awol-void-mute.sql`, which is the house pattern for "an admin
act that changes a record people are judged by":

- `security definer`, `set search_path = public`
- **the passcode is verified inside the function, first**, via `admin_verify_passcode()` — the
  same globally-throttled gate the kiosk admin panel uses (10 failures → 15-minute lockout).
  Never a passcode check in the browser that the server trusts.
- returns `jsonb` — `{ok:true, …}` or `{ok:false, reason:'…'}`. Business refusals are **returned,
  not raised**, so the dashboard can show the owner a sentence instead of a Postgres error.
- cheap input-shape checks (is `type` in the allowed set?) run *before* the passcode check, so the
  verification script can prove the closed set without ever holding a real passcode.
- `grant execute … to anon, authenticated`.

Three functions, one per direction, so the audit is symmetric and unambiguous:
`holiday_add()`, `holiday_edit()`, `holiday_delete()`.

**The delete guard.** `holiday_delete()` refuses once that date's payroll has run, and returns the
reason in plain words. **What "payroll has run" means is Q5 — the system does not currently record
it.**

**Audit.** Every call appends to `holiday_audit` (append-only, no update or delete granted): what
changed, from what to what, who, when. Separate from `attendance_edit_audit`, which is the
immutable record of *punch* edits and should not grow a second meaning.

---

## 4. Admin dashboard — the Holidays section

Lives in `home.js`, in Settings, as its own `sectlabel` block alongside "Night shift schedule" and
"Attendance times (kiosk override)" — it is the same kind of thing: a calendar rule the whole
system obeys.

- **List** — upcoming first, then past, showing date, name, type, scope. Past holidays stay
  visible; they are what the payroll computed from.
- **Add** — date, name, type, scope, then the admin passcode.
- **Edit** — same fields, same passcode.
- **Delete** — passcode, plus a confirm naming the date. Refused with a readable reason once that
  date's payroll has run (§3).
- Type is shown in words, not codes: "Regular holiday", "Special non-working day",
  "Special working day (ordinary pay)".

---

## 5. The Telegram notice

On successful add **or** edit:

> `Holiday added: [name], [date], [type] — please post on the wall.`

(Edit sends the same line with `Holiday updated:`. The wall copy is now wrong and someone has to
reprint it, which is the entire point of the message.)

**The notifier never writes state.** It reads the holiday it was handed and sends. It sets no flag,
claims no row, and updates nothing — so it can fail, be retried, or fire twice without corrupting
anything. This is safe here in a way it is not for the cutoff reminder: that one is fired by cron
and needs a send-log to avoid duplicates, whereas this one is fired by a human pressing Save, so
"once per press" is already the natural behaviour and no dedupe state is needed.

**Where the send happens — technical, my call, recorded because it has a visible consequence.**
The dashboard sends it after the RPC returns `ok:true`, rather than the database sending it via
`pg_net` inside the transaction. Reason: a Telegram outage must never roll back a holiday that was
correctly recorded. The cost is that if the browser dies between the write and the send, no notice
goes out — so the dashboard says so plainly rather than silently:

> Holiday saved — but the Telegram notice did not send. Post it on the wall yourself.

Routing to the existing group (the same `settings` chat key the other notices use). Token handling
unchanged; the anon-readable `tg_token` exposure is a separately-tracked item and this feature does
not make it worse.

---

## 6. Computation

**Forward-only.** A `holidayPayFrom` date in `settings.payroll_cfg`, exactly like the live
`sundayPremiumFrom`. Holidays dated before it compute nothing, ever. Past payrolls must not move
when this ships — that is non-negotiable and it is why the switch is a date and not a boolean.

**PEM/pakyaw workers are excluded entirely** — see §8.

### 6.1 Regular holiday

| | condition | pay |
|---|---|---|
| **Worked** | — | **200%** of the daily rate |
| **Unworked** | has an actual punch on the last scheduled workday before the holiday | **100%** of the daily rate |
| **Unworked** | no such punch | **nothing** |

> **House rule, stricter than DOLE — stated deliberately.** DOLE qualifies a worker for unworked
> regular-holiday pay if they were present *or on approved leave* on the day immediately preceding.
> **Here, approved leave does not qualify. Only an actual punch does.** This is the owner's rule and
> it is more demanding than the law requires. A man on approved VL the day before a regular holiday
> gets his leave pay for the leave day and **nothing** for the holiday.

### 6.2 Special non-working day

| | condition | pay |
|---|---|---|
| **Worked** | has an actual punch on the last scheduled workday before the holiday | **130%** of the daily rate |
| **Worked** | no such punch | **base rate, no premium** — an ordinary day |
| **Unworked** | — | **nothing** |

> **House rule, stricter than DOLE — stated deliberately.** DOLE applies **no day-before condition
> at all** to a *worked* special non-working day: whoever works it earns 130%, full stop. The
> day-before punch requirement here is the owner's addition. A man who was absent Friday and works
> the Saturday special non-working day is paid his ordinary rate, not 130%.

### 6.3 Special working day

Treated as an ordinary workday. No holiday computation, no premium, no qualification test, no
"exempt" or "unqualified" label. It appears in the Holidays list so the owner knows it was
considered and deliberately carries no premium.

### 6.4 What "200%" and "130%" mean in this codebase — read before implementing

**The worked-day base is already being paid.** A worked holiday has a punch, so it is already in
`daysPresent`, and `dayPayAll = dailyRate × daysPresent` already pays it at 100%. Therefore:

- worked regular holiday → holiday pay adds **+100%** (100% existing + 100% new = 200%)
- worked special non-working, qualified → holiday pay adds **+30%** (100% + 30% = 130%)
- **unworked** holiday → there is no attendance row, nothing is being paid, so regular-holiday
  qualification adds the **full 100%**

Implementing 200% and 130% as literal multipliers on top of what already exists **doubles a man's
holiday pay**. This is the single most likely way this feature mispays, and it must be verified
against the owner's hand computation (§12) precisely because the arithmetic is not what the
percentages look like.

---

## 7. "The last scheduled workday before it" — the load-bearing phrase

Both qualification rules turn on this, and **the system has no concept of a scheduled workday.**
There is no roster, no shift calendar, no rest-day field. The only day the payroll treats specially
is Sunday, which gets a rest-day premium — and men *do* work Sundays.

So "the last scheduled workday" cannot be computed today. It has to be defined. **Q1 is blocking**
and nothing else in §6 can be built until it is answered.

Whatever the definition, two things hold:

- **"Actual punch" means a `timein` on that date in `attendance_records`** — the same test the
  payroll already uses (`filter(r => r.timein)`). Not a leave record, not a suspension record, not
  a manual note.
- **The date comparison goes through the normaliser**, never a raw string match, because attendance
  dates are stored in two formats and a direct comparison silently finds nothing.

---

## 8. PEM / pakyaw workers

Excluded from all holiday computation, **displayed as "exempt — PEM", never silently skipped.**
Pakyaw men are paid by output, so a day rate has no meaning for them; showing the exemption on
screen is what stops the owner wondering whether the system forgot someone.

**The marker is `employees.employment_type = 'pakyaw'`, never the code prefix.** A converted man
keeps his PEM code and must read as regular everywhere — this is a standing rule already enforced
in the kiosk, `home.js` and the AWOL detector, and holiday pay must not be the one place that
reintroduces a `/^PEM/` test.

Two consequences worth the owner knowing:

- **`employment_type` has no UI.** It is set only by SQL migration. If a man's type is wrong, this
  feature has no screen to fix it and neither does any other. Not in scope here; recorded because
  holiday pay is now the third feature depending on a column nobody can edit.
- **`type_effective_from` exists and is currently ignored.** A converted worker has a date from
  which his new type applies. `isPakyaw()` in `home.js` does not consult it. **Q7** asks whether
  holiday pay should — it matters only for a man converted mid-history, and getting it wrong pays
  or withholds a full day.

---

## 9. What the screens show

### 9.1 Payslip

A separate **"Holiday pay"** line, rendered only when nonzero.

**This line already exists** — in both payslip renderers (`payroll/index.html:1202` and `:2118`),
reading a field called `holPay`, guarded by `> 0`. It has never had a value. So the payslip work is
already done; what is missing is the number and one thing more, in §10.

### 9.2 Payroll screen

For a worker who does not qualify, the reason on the card:

> `no holiday pay — absent/on leave [date]`

where `[date]` is the last scheduled workday he missed. Pakyaw men read `exempt — PEM`.

**Owner override.** Passcode-gated and audited, on the payroll screen, per worker per holiday. It
records who overrode, when, for whom, on what date, and what the computed result had been — written
to `holiday_audit` and never to the punch record. The override grants the holiday pay the man
would have received had he qualified; it does not let the owner type an arbitrary peso amount
(that is what `payroll_adjustment` is already for, and two ways to do the same thing is how ledgers
drift).

---

## 10. Collisions with the live code

Found by reading the current `payroll/index.html`. Each is a real defect the implementation must
handle, not a hypothetical.

**1 — `netOf()` does not include `holPay`.** The net is
`basic + restDayPay − lateUT + otPay + ndPay + otAllowance + stayInAllowance + leavePay − deductions`.
Holiday pay is absent. So the moment `holPay` gets a value, **the payslip would print a Holiday pay
line that is not in the total** — the man sees it and does not get it. `netOf()` must gain the term
in the same change that first sets the field, never separately.

**2 — the computation loop only visits worked days.** `rs` is filtered to `r.timein`, so an
unworked holiday has nothing to iterate. Unworked holiday pay has to accumulate *outside* that
loop, the way `leavePay` already does via `leaveInfoFor()`. That is the right home for it and the
pattern already exists.

**3 — a man whose only pay that week is unworked holiday pay disappears.** The early return
`if (!rs.length && !leave.paidDays && !leave.unpaidDays) return;` drops any worker with no punches
and no leave. A worker who was present the day before a Monday holiday, and whose week then
contains nothing else, qualifies for 100% and would **vanish from the payroll entirely** — no card,
no payslip, no line. The guard must gain a holiday term.

**4 — the 200%/130% arithmetic is not what it looks like.** See §6.4. Worked days are already paid
at 100% before holiday pay is added.

**5 — undertime interacts.** `lateUT` deducts the shortfall against a full shift. A man who works
four hours of an eight-hour holiday earns the premium on what — the hours worked, or the day, less
undertime? **Q3.**

---

## 11. Questions for the owner — ALL RESOLVED 2026-08-15 / 2026-08-22

> **RESOLUTIONS. The questions below are kept verbatim as the record of what was asked; the answers
> are here, and they are what the code implements.**
>
> | | answer |
> |---|---|
> | **Q1** qualifying day | **(b)** the day the yard last ran — walk back past Sundays and past other paid holidays to the most recent day anybody punched. 14-day look-back; beyond that, "the yard did not run", stated on screen. |
> | **Q2** holiday on a Sunday | **(b) STACKED**, per DOLE. Regular holiday on a rest day = 260%, its OT ×3.38. *Extended by inference:* a **special** non-working day on a Sunday = **150%** (DOLE's figure), not 1.30×1.30. |
> | **Q3** partial day | 100% daily wage **plus hours actually worked at the ORDINARY hourly**. Equivalently ₱1,200 less undertime at ₱75/h. The holiday line carries **no** undertime term — the base `lateUT` already does it. Self-floors at the unworked entitlement. ₱600/day: 8h→₱1,200 · 4h→₱900 · 2h→₱750 · 0h→₱600. |
> | **Q4** holiday OT | **(b)** the holiday-adjusted rate, per DOLE. Regular holiday OT ×2.60. Night differential stacks on the same uplifted rates. |
> | **Q5** "payroll has run" | The day is **CLOSED** (`attendance_day_lock`). Delete, edit and override all refuse on a closed day. |
> | **Q6** `scope` | Recorded only. Every holiday applies to every worker. |
> | **Q7** converted pakyaw | Type as it reads **today** (`employment_type`), consistent with the kiosk, `home.js` and the AWOL detector. `type_effective_from` remains unused. |
>
> **Effective date: `holidayPayFrom = 2026-08-15`** (owner, 2026-08-22) — the first day of the pay
> week 08-15 → 08-21, which is paid on 08-22. Deploying before that run puts the Friday 08-21
> special-day premium into the normal payment; nothing already settled recomputes.

### The questions as originally put

Plain language, with a real example each.

**Q1 — What is "the last scheduled workday before the holiday"?** *(blocking, nothing computes
without it)*
The system has no work calendar. Suppose a holiday falls on **Tuesday 26 August**. Which day must
the man have punched?
&nbsp;&nbsp;**(a)** The calendar day before — Monday. If Monday were itself a holiday or a Sunday, he
simply fails.
&nbsp;&nbsp;**(b)** The most recent day the yard actually ran — walk backwards past Sundays and past
other holidays until a day is found where *somebody* punched.
&nbsp;&nbsp;**(c)** The most recent day **that man** was scheduled, which the system cannot know
today and would need a roster built first.
*(b) is the most forgiving and needs no new data. (a) is simplest and strictest. Recommend (b).*

**Q2 — A holiday that falls on a Sunday.** Sunday already pays a 30% rest-day premium, and Sunday
OT already pays ×1.69. If a regular holiday lands on a Sunday and a man works it, does he get
&nbsp;&nbsp;**(a)** holiday only — 200%, the Sunday premium is absorbed;
&nbsp;&nbsp;**(b)** both stacked — DOLE's rule is 260%;
&nbsp;&nbsp;**(c)** whichever is larger, and nothing else.
*Real example: a man on ₱600/day works a regular holiday falling on a Sunday. (a) pays ₱1,200,
(b) pays ₱1,560, (c) pays ₱1,200. This will happen — it is not rare.*

**Q3 — Half a holiday.** A man on an ₱600/day rate works **four hours** of a regular holiday, then
goes home. Does he get
&nbsp;&nbsp;**(a)** ₱1,200 — the full 200%, because he showed up and holiday pay is a day rate;
&nbsp;&nbsp;**(b)** ₱600 — 200% of the four hours he actually worked;
&nbsp;&nbsp;**(c)** ₱1,200 less the undertime deduction the payroll already applies.

**Q4 — Overtime and night work on a holiday.** A man works **11 hours** on a regular holiday — three
hours past his shift. The three OT hours are paid at
&nbsp;&nbsp;**(a)** the ordinary OT rate (×1.25), same as any day;
&nbsp;&nbsp;**(b)** the holiday-adjusted OT rate — DOLE's is ×2.60 on a regular holiday;
&nbsp;&nbsp;**(c)** no OT premium on holidays at all.
*The same question applies to night-differential hours worked between 10 PM and 6 AM on a holiday.*

**Q5 — What counts as "payroll has run" for that date, so the holiday can no longer be deleted?**
The system does not record a payroll run anywhere. Nearest existing markers:
&nbsp;&nbsp;**(a)** The day is **closed** (`attendance_day_lock` has a row for it) — already exists,
already means "this pay day is settled".
&nbsp;&nbsp;**(b)** Vale deductions were **posted** for the week containing it.
&nbsp;&nbsp;**(c)** A new record written whenever payslips are printed.
*Recommend (a): it already exists, the owner already performs it deliberately, and it already means
the day is final.*

**Q6 — What does `scope` = local actually do?** The brief records the column but no rule uses it.
The yards are Carmen and Mandaue. If a holiday is local — a city fiesta, say —
&nbsp;&nbsp;**(a)** it applies only to workers whose home site is that yard (and the table then needs
a `site` column, because "local" alone does not say *where*);
&nbsp;&nbsp;**(b)** it applies to everyone, and `scope` is recorded for the record only.
*As specified, `scope` is (b) — a label. Confirm that is intended.*

**Q7 — A man converted from pakyaw to regular.** Suppose he converted on **1 July** and a holiday
falls on **26 August**. He is regular now. Does the holiday check
&nbsp;&nbsp;**(a)** his type today — he is regular, so he is included;
&nbsp;&nbsp;**(b)** his type on the holiday date, using `type_effective_from`.
*They differ only for a man who converts between the holiday and payday. Recommend (b), but (a) is
what every other feature in the system currently does, and consistency has its own value.*

---

## 12. Acceptance gates

1. **The owner reviews this spec before any code is written.** Nothing starts until §11 is answered.
2. **The migration ships with its rollback**, written at the same time, in the same commit — the
   standing rule. The rollback snapshots to `bak_` tables and refuses the drop if the snapshot is
   short.
3. **The SQL is not run until the owner runs it**, in a payroll-quiet window, following the
   two-project rule: close the other Supabase tab, confirm `select current_database();` from inside
   the tab, and lead with the canary `select count(*) from public.attendance_records;` which errors
   immediately in the inventory project.
4. **The implementation reproduces the owner's manual computation to the centavo** on a localhost
   test week containing **one regular holiday and one special holiday**. The owner computes the week
   by hand first; the screen must match every worker, every line, exactly. A discrepancy of any size
   is a failure, not a rounding note.
5. **Past weeks must not move.** Re-running a pre-`holidayPayFrom` week before and after deployment
   produces byte-identical totals for every worker.
6. **Both house rules are verified as written** — a man on approved leave the day before a regular
   holiday gets nothing for the holiday, and a man absent the day before a worked special
   non-working day gets base rate with no premium.
7. **`node --check` on the extracted inline script, plus the hygiene grep** (`wpmcbjrisuyjvobvzaus`
   present, `azfmpleswqixaslvcito` absent) before anything is shown as finished.
8. **Localhost walkthrough before push.** Payroll and the dashboard are surfaces the owner and
   workers interact with, so the deploy rule applies with no exception.
9. **Nothing pushes without the owner's explicit word.**

---

## 13. Deployment notes

- `payroll/index.html` and `home.js` both get version-stamp bumps, and `preflight.html`'s `EXPECT`
  entries move in lockstep. Payroll's `checkBuildFresh()` reads that file and disables every edit
  and decision path on a mismatch, so a stamp bumped on one side alone takes the payroll screen
  down.
- Tablets and phones need `reset.html` to pick up the new build.
- The five `_buildStale` guards on the payroll decision paths are the model for the override in
  §9.2: an override is a decision, and a decision written from a cached build is the silent no-op
  those guards exist to prevent.
