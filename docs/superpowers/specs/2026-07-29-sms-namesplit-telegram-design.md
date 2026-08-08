# SMS templates · personnel name split · AWOL Telegram alerts

**Date:** 2026-07-29
**Status:** DRAFT — owner review. No code written.
**Related:** `2026-07-29-awol-case-lifecycle-design.md` (the case states these alerts announce).

---

# Part 1 — SMS templates (Bisaya only, full names, date `Jul 28`)

## Measured set

Date token = `Jul 28` (6 chars). Roster: 43 workers, **35 with a phone** — only those can receive
an SMS. Longest name among them: **`John Michael Armenion` (21 chars, RSR 0020)**.

**OWNER-CONFIRMED 2026-07-29:** `inyu` dropped from day 1; day 2 keeps its date.

## SMS sending is behind a flag, default OFF — built ready, left dormant

**OWNER-REQUIRED 2026-07-29.** Everything in Part 1 is built, tested and wired, and **sends
nothing** until the owner switches it on.

- One setting, `sms_enabled`, default `false`, in a REST-locked table — **not** in `settings`,
  which anon can read and therefore anon could try to write.
- Read **inside** the send function, on every send. Not cached at startup, not passed in by a
  caller. A flag that can be bypassed by a code path that forgot to check it is not a flag.
- With the flag off, the sender does everything it normally does — resolves the man, renders the
  template, checks the phone — and then writes a `suppressed` ledger row **instead of** calling
  Semaphore. So the dormant path exercises the same code the live path will, and the day the flag
  flips, nothing runs for the first time in production.
- `no_phone` is evaluated **before** the flag. A man with no number resolves to `no_phone` whether
  sending is on or off, because that is the true reason nothing was sent to him.

Turning it on is a one-row update the owner makes; nothing needs deploying. Turning it back off is
the same, and is the first thing to do if anything looks wrong.

**Order of work:** build → verify against the ledger with the flag off → register the sender name →
collect the two missing numbers → flip the flag. Phone numbers last, as instructed; the design does
not depend on having them.

| | Fixed text | Room for name | Worst case | Spare | Credits | Breaks at |
|---|---|---|---|---|---|---|
| **Day 1** (final) | 130 | 30 | 151 | **9** | 1 | 31-char name |
| **Day 2** (final) | 137 | 23 | 158 | **2** | 1 | 24-char name |
| **Day 3+** (final) | 131 | 29 | 152 | **8** | 1 | 30-char name |

**All three fit every name on the roster at 1 credit.** Cost stays ~₱47/month at current volume.

### Day 1 — FINAL
```
{name}, absent ka niadtong {date} nga walay approved nga leave. {daysLeft} pa ka adlaw ug AWOL na. Pag-report o pag-file ug leave sa coordinator.
```
`inyu` dropped: buys 5 characters and matches day 3+, which already says `ang coordinator` with no
possessive.

### Day 2 — my draft, matching tone
```
{name}, ika-2 ka adlaw nga absent {date} nga walay approved nga leave. {daysLeft} pa ka adlaw ug AWOL na. Pag-report o pag-file ug leave sa coordinator.
```
Rendered: `John Michael Armenion, ika-2 ka adlaw nga absent Jul 28 nga walay approved nga leave. 1 pa ka adlaw ug AWOL na. Pag-report o pag-file ug leave sa coordinator.`

Day 2 is structurally the tightest of the three: it has to say "second day", which days 1 and 3
express more cheaply. Two ways to buy margin if you want it — **drop the date** (he knows what day
it is; saves 7, brings it level with day 1), or shorten the closing clause, which costs the
"report for work" instruction. I'd keep it as drafted; 2 spare characters covers your roster and
any name up to 23.

### Day 3+ — yours, verbatim
```
{name}, 3 ka adlaw ka nang absent nga walay approved nga leave hangtod {date}. Naka-flag na imong account. Kontaka dayon ang coordinator.
```
**Says `Naka-flag` — flagged. Never `suspendido`, never `naka-lock`.** This is load-bearing: under
the case-lifecycle spec nothing is suspended or locked at any automatic step, so a message saying
otherwise would be false at the moment it is sent, and it is the text that ends up quoted in the
NTE. Any future edit that reintroduces a lockout word is a bug, not a wording preference.

## Three build rules

**1. `daysLeft` is derived, never hardcoded.**
`kiosk/index.html:4624` already computes `const daysLeft=3-consecutiveDays;` and then never uses
it — the literals "2 remaining days" and "1 remaining day" are typed into the strings. The new
templates take `{daysLeft}` as a parameter. Change the threshold from 3 and every message follows;
today they would silently keep saying "2" while the rule said something else.

**2. The Sunday rule is read from one function.**
`isSundayKey()` (`kiosk/index.html:2253`) is already the single source — `collectAbsentDates()`
calls it at `:2267` and `checkAndSendAbsenceSMS()` at `:4649`. That is correct today and must stay
that way.

> **The risk is the server-side move.** `isSundayKey` is JavaScript. When sending moves to
> `pg_cron`, the schedule needs the same rule in SQL, and there would then be **two**
> implementations that can drift. The SQL function `awol_count_absent_workdays()` from the
> lifecycle spec becomes the single authority, and the kiosk's JS copy is demoted to display only.
> One rule, one place, enforced where the decision is made.

**3. Non-GSM-7 guard: log and send, never truncate.**
Verified: **all 43 roster names are GSM-7 safe today** — `ñ` in *Tañola* and *Niño* is in the GSM
basic charset. But one future hire with a character outside it flips the whole message to a
70-character-per-segment encoding.

The guard measures the rendered message before sending and:
- if it exceeds 160 GSM-7 characters, or contains any non-GSM-7 character → **write a warning row
  and send the message in full anyway**;
- **never truncate.** The clause that says `AWOL` sits at the end of every template. A truncated
  notice would drop precisely the words that make it a warning while still reading as a complete
  message.

The extra ₱0.50 is not worth reasoning about. A notice that cuts off mid-sentence in a dismissal
file is.

---

# Part 2 — Personnel name split

## Correction first: there is no `full_name` column

`full_name` appears exactly once in the repo — `schema.sql:25` — in an `employees` table
definition with `emp_code`, `site_id` and `active`. **None of that matches production.** The live
table uses `code`, `name`, `home_site`. Queried directly:

```
GET /employees?select=full_name  →  42703  column employees.full_name does not exist
```

`schema.sql` was stale fiction — anyone writing SQL from it produced something that could not run.
**Deleted 2026-07-29 on the owner's instruction** (recoverable from git history at `c6ead88`).
Deleting was safer than regenerating: every statement was `create table if not exists`, so pasting
it into the SQL editor did nothing where a table already existed — no error, no warning, no sign
the file was wrong. A regenerated dump would only reset the staleness clock, since there is no
build step or migration runner to keep it in sync, and it would still look runnable against
production.

**So the split targets `employees.name`.**

## The change

Add `first_name`, `middle_initial`, `last_name`, `suffix` (for `Jr.` / `Sr.` / `III`). **Keep
`name` populated and readable — hide it in the form, never drop the column.** After the split it
is maintained as a generated value from the parts, so every existing reader keeps working
untouched and no migration is forced on any other page.

`suffix` is its own field precisely because `Baylon Salvador Jr.` exists on the roster today, and
because a suffix must never be mistaken for a last name in a formal notice.

## Every place that reads the employee name

Two categories, and the distinction is the whole point.

### A. Live reads of `employees.name` — these follow automatically

| File | What it does | Needed |
|---|---|---|
| `material-issuance/index.html:301` | `select('id,code,name,position')` | nothing — `name` still exists |
| `payroll/adjustments.html:102` | `select('code,name')` | nothing |
| `tools/index.html:514,740,755,957` | `select('id,code,name')` and `employees(name)` joins | nothing |
| `home.js:82` | `employees(name)` join | nothing |
| `app.js:80,163` | `employees(name)` joins | nothing |
| `coordinator.js` | roster read + employee create/edit | **the form itself** — this is the page being changed |
| `kiosk/index.html` | roster into `employees[]`, used for display and SMS | nothing, unless you want the kiosk to show a different name format |
| `payroll/index.html`, `payroll/diagnostic.html`, `preflight.html`, `tests/…` | roster reads | nothing |

Because `name` stays populated, **the only file that must change is `coordinator.js`** — the form.
That is the entire benefit of hiding rather than deleting.

### B. Denormalised `employee_name` snapshots — these do NOT follow, by design

`employee_name` is copied into the row at write time in: `leave_requests`, `sms_log`,
`employee_suspensions`/`awol_events` paths, `payroll` records, `personnel-kpi.sql`, and the
`leave_decide` RPCs.

These are **historical snapshots, not references.** A leave approved in June should keep the name
as it was written in June. Splitting the source does not and must not rewrite them. Nothing to do
here — recorded so nobody later "fixes" the inconsistency and silently rewrites history.

## `normCode` is unaffected — confirmed

`normCode` and the DB's `code_norm` operate on `employees.code`
(`upper(regexp_replace(code,'[^A-Za-z0-9]','','g'))`). **No lookup anywhere matches on the name.**
The unique index `employees_code_norm_uniq` is on the code. The name split cannot affect employee
matching, leave lookups, suspension matching, or payroll joins.

## The 35 existing rows are NOT auto-split

Automatic splitting would guess wrong and nobody would find out until a notice addressed a man
incorrectly. The roster already proves the risk: **`Presillas Christian` (RSR 0022)** and
**`Baylon Salvador Jr.` (RSR 0002)** are stored in an order a naive first-token split gets wrong —
it would address one man by his surname and the other by his father's.

Instead: a **review list** — one screen, all 43 rows, current `name` on the left, four empty boxes
on the right, pre-filled with a *suggestion* that is clearly marked as a guess. A human confirms
each row. Unconfirmed rows keep working on `name` alone. No deadline, no bulk action, no "apply
all".

---

# Part 3 — AWOL group Telegram alerts

## Correction: Telegram does not drop emoji

Your instruction says the send path renders them as `?`. **That is the SMS path, not Telegram.**
Telegram messages are sent as JSON with `parse_mode: 'HTML'` (`kiosk/index.html:1572`), which
carries emoji intact — the live AWOL alerts already use 🚨, ✅ and 📄, and they arrive correctly.
The `?` substitution is a GSM-7 encoding artifact and belongs to Semaphore.

**Specced with no emoji anyway** — it's your call what the group sees, and plain text reads more
like a record and survives copy-paste into a document. Recording the reason only so the constraint
isn't later removed on the grounds that "the stated reason was wrong."

## The six messages

**OWNER-CONFIRMED 2026-07-29.** Em-dashes replaced with plain hyphens throughout — these strings
are typed into SQL files on a machine whose tooling defaults to cp1252, and `—` (U+2014) is one
substitution away from becoming `?`. Same reason the templates carry no emoji. **Everything below
is pure ASCII by design; keep it that way.** The only non-ASCII that can reach these messages is an
interpolated name (`Tañola`, `Niño`), which arrives from the database at send time and never passes
through a SQL literal.

`{dates}` renders as `Jul 26, Jul 27, Jul 28` — matching the SMS date format.

**Detected** — fires IMMEDIATELY on detection, not on the daily sweep
```
AWOL - {full name} ({code})
Absent: {dates} - walay leave.
NTE andam na. Ipapirma inig balik niya.
```

**Served** — daily sweep
```
NA-SERVE - {name}
Pirma: {served_date} (gi-record ni {receiver})
Deadline sa explanation: {deadline}
Makatrabaho ug sweldohan gihapon hangtod sa desisyon.
```

**T-2** — daily sweep
```
PAHINUMDOM - {name}
2 ka adlaw na lang. Deadline {deadline}.
Wala pay explanation nadawat.
```

**Deadline day** — daily sweep
```
DEADLINE KARON - {name}
{deadline} ang katapusan. Wala pay explanation.
```

**Lapsed** — daily sweep
```
LAPSED - {name}
Na-serve {served_date}. Deadline {deadline}. Walay explanation.
Draft nga letter andam na. Imong desisyon.
```

**Submitted** — daily sweep
```
NI-SUBMIT - {name}
Nadawat: {date} (ni {receiver})
Imong desisyon ang sunod.
```

## Two triggers, not one

**Detected is immediate.** It fires from the detection path the moment a case opens, so the office
hears about a man on the day he crosses three absences, not the following morning.

**The other five are one daily sweep.** They read case rows, work out which of `Served`, `T-2`,
`Deadline karon`, `Lapsed` and `Submitted` are true today, and send. `T-2` and `Deadline karon` are
computed from `served_date` each run — nothing schedules them, they are simply true or not on the
day the sweep runs. A missed run therefore skips a reminder rather than corrupting anything, and
the next run recomputes from scratch.

The **Served** message carrying `Makatrabaho ug sweldohan gihapon hangtod sa desisyon` is the one
that matters most operationally — it is the group being told, in writing, that the man is still
working and still being paid. That is the no-lockout policy stated where the people who would
otherwise turn him away can read it.

## The notifier is strictly read-only

It **reads** case rows and **sends** messages. It must never:

- write or advance case state — `lapsed` stays derived, computed at read time from `served_date`;
- generate, store or attach any document, including the day-6 draft (it may *say* a draft is
  available; it may not produce one);
- write to `employee_suspensions`, `awol_events`, or anything that affects kiosk access.

Enforced structurally, not by discipline: the notifier authenticates as a role with **`select`
only** on the case tables. Then a future edit that tries to write fails loudly at the database
instead of quietly changing a man's status overnight.

Read-only does NOT extend to the delivery ledger below — that is the notifier's own bookkeeping
about its own sends, and writing it changes no case state and affects nobody's access.

---

# Part 4 — Delivery must be confirmed, and failures must surface

**OWNER-REQUIRED 2026-07-29. This applies to every alert path, not just the AWOL notifier.**

## The problem this exists to prevent

`sms_log` holds **106 rows, 0 delivered**, going back to 2026-06-25 — and nobody knew, because
`sendAbsenceSMS()` captured `result.error` and then dropped it when building the log row. The log
recorded that an attempt happened and said nothing about whether it arrived.

Every alert path in the system currently has the same defect:

| Path | How the error disappears |
|---|---|
| `sendAbsenceSMS` (SMS) | builds `logEntry` without `result.error` |
| `notifyAwol` (`home.js:36`) | `.catch(() => {})` and an outer `catch (_) {}` |
| `kiosk_alert_send` (`kiosk-alerts.sql`) | `exception when others then null` |
| **`net.http_post` itself** | **fire-and-forget by design** |

That last one is the trap specific to the server-side path. `net.http_post` **queues** the request
and returns a `request_id`; the actual HTTP response lands later in `net._http_response`. The call
returns successfully even when Telegram rejects the message — wrong chat id, bot removed from the
group, token rotated. **Delivery status is simply not knowable at the moment of the call.**

## The rule

**No alert path may discard an error.** Not the SMS sender, not the Telegram senders, not the
notifier. If a send fails, the failure is recorded with its reason.

## How it works

Every send writes a row to `alert_deliveries` **before or as it sends**, capturing the
`request_id` that `pg_net` returns:

```
alert_deliveries
  id            uuid pk
  channel       text        -- 'telegram' | 'sms'
  purpose       text        -- 'awol_detected', 'awol_t2', 'absence_day1', ...
  employee_code text        -- nullable; group messages have none
  target        text        -- chat id or phone
  body          text        -- exactly what was sent
  request_id    bigint      -- from net.http_post; null for browser sends
  status        text        -- see the five states below
  http_status   integer
  error         text        -- the reason, NEVER discarded
  sent_at       timestamptz
  settled_at    timestamptz
```

### Five states, and only two of them are failures

| Status | Means | Counts as a failure? |
|---|---|---|
| `delivered` | The provider accepted it | no |
| `failed` | Attempted and rejected, or no response inside the window | **yes** |
| `queued` | Sent, awaiting reconciliation | no (yet) |
| `no_phone` | **No number on file for this man. Nothing was attempted.** | **never** |
| `suppressed` | Sending is switched off (see the flag below) | **never** |

**`no_phone` is a distinct state and is never counted as a failure.** A man with no number on file
is not a broken alert path — nothing was attempted, nothing malfunctioned, and no amount of
retrying fixes it. Counting it as a failure would light the alerting-health banner permanently and
train everyone to ignore it, which is how the 106 silent SMS failures survived a month.

It still gets a **row**, because "we could not tell him" is exactly the fact the NTE has to state.
Silence must be recorded, never inferred from an absent row.

`suppressed` works the same way: a row is written, sending is skipped, and the ledger can later
prove the system saw the absence and deliberately said nothing.

The alerting-health banner and the group digest count **only `failed`**.

## Current exposure: 3 workers, not 8

Measured 2026-07-29 — 43 on the roster, **35 with a phone, 8 without**:

```
PEM 0001 Julius     PEM 0002 Jembo      PEM 0003 Warren
PEM 0004 Erwin      PEM 0005 Melvin     <- all PAKYAW: AWOL-exempt, no notice is ever owed
RSR 0000 Raffy Ramirez   <- the test account
RSR 0001 Elias Entero
RSR 0034 Chrismark Ybas
```

Five of the eight are PEM and exempt from AWOL entirely, so they can never be owed a notice. One is
the test account. **Two real workers need a number collected: Elias Entero and Chrismark Ybas.**
Until then both resolve to `no_phone`, cleanly and without ever looking like a fault.

A **reconciler** runs after each sweep (and on its own short schedule): for every row still
`queued`, it looks up `net._http_response` by `request_id` and settles it to `delivered` or
`failed`, recording `http_status` and `error`. Rows that never get a response inside a defined
window settle to `failed` with `error = 'no response'` — silence is a failure, not an unknown.

`sms_log` gains the same treatment: keep the existing row, add the dropped error. Never again a
column that says `Failed ❌` with no reason attached.

## Where failures surface — this is the part that matters

A ledger nobody reads is the same as no ledger. Failures surface in **three** places, deliberately
overlapping, because the whole point is that the owner sees them without going to look:

1. **A daily digest line to the AWOL group**, appended by the sweep itself:
   `ALERTO - {n} ka mensahe wala nakalabay karon. Tan-awa ang dashboard.`
   Sent only when `n > 0`. It goes to the same group as everything else, so a silent failure of
   the *alerting* system announces itself on the channel already being watched.
2. **A red banner on the admin dashboard**, in the pattern already used for stuck punches: any
   `failed` row in the last 7 days that nobody has acknowledged puts it on screen.
3. **The AWOL case itself.** If a case's own alerts failed, the case shows it. The owner must never
   read `Served - deadline Aug 3` on a case and assume the group was told when it wasn't.

**The failure that must never be silent is a total one.** If the token is rotated or the bot is
removed from the group, *every* Telegram send fails — including the digest at (1). That is exactly
why (2) and (3) exist and do not depend on Telegram. The dashboard banner is the backstop, and it
is reachable when Telegram is not.

---

# Decisions confirmed 2026-07-29

1. **Day 1 — `inyu` dropped.** 9 characters spare, matches day 3+.
2. **Day 2 — keeps its date.** 2 characters spare, covers every current name and any up to 23.
3. **Detected fires immediately; the other five are one daily sweep.**
4. **`{dates}` renders `Jul 26, Jul 27, Jul 28`**, matching the SMS format.
5. **Em-dashes replaced with plain hyphens** in all six alert templates (cp1252 authoring risk).
6. **Delivery confirmation required** on every alert path — Part 4.
7. **`schema.sql` deleted** (2026-07-29). It declared `employees.emp_code`, `full_name`, `site_id`
   and `active` — all four verified absent from the live table — under a real table name, so it
   read as authoritative while being entirely wrong. Recoverable from git history at `c6ead88` if
   ever needed.

## Still open

`app.js:1013` shows users a Supabase connection error telling them to check *"that you ran
`schema.sql`"* — a file that no longer exists. It is worker-visible text, so the replacement
wording is the owner's call. The message is only reachable when Supabase is unreachable.
