# AWOL Suspension Flow — kiosk block modal, printable letter, dedicated AWOL group (2026-07-24)

## Status
Designed + approved 2026-07-24. **Letter (rendered) and full flow approved by the owner.** Build order:
**this feature BEFORE the queued full-day Time-In gate** (`2026-07-24-full-day-timein-gate-design.md`).
Worker-facing **and** punch-blocking → **full localhost walkthrough gate before any push to `main`.**

**Owner decisions locked:**
1. **Pending leave → HOLD + flag.** An employee absent 3+ days who has a *Pending* (filed, not yet
   approved) leave covering those dates is **not** suspended; the AWOL group gets a one-time "please
   decide" note. Suspend only if that leave is Rejected (or none was filed).
2. **Alert routing → dedicated AWOL group ONLY** (single running open/resolved log). Not the manager DMs
   — except as the graceful fallback while the group chat ID is unset (see Rollout).
3. **Reinstatement UI stays as-is** — kiosk Admin ▸ Staff roster button + Telegram buttons. No new
   control on the RSR Admin dashboard page.
4. **Suspension state is DB-shared, not per-device.** A worker who hits AWOL at Carmen is blocked at
   Mandaue too (and vice versa); reinstatement from any surface clears the block on **both** kiosks. A new
   `employee_suspensions` Supabase table is the source of truth; each kiosk keeps its local
   `suspendedEmployees` object only as a **read-cache** refreshed from the table.

## Goal
Turn the existing (already-working) AWOL suspension **detection** into a complete, humane, auditable flow:
a worker learns at PIN entry that they're suspended and what to do; the coordinator gets an automatic
alert with a **printable letter** to hand-fill at the yard; and all AWOL cases live in one Telegram group
that reads as a running log of open vs resolved.

## What already exists (reused, not rebuilt)
- **Detection** — `checkAllAbsences()` (kiosk) runs on the midnight/boot schedule. `getConsecutiveAbsences`
  counts backward from yesterday; `isAbsentOnDate` = *no Time-In AND no Approved leave* that date. Suspends
  at `>= 3`. Client-side, off cloud-synced records + `leaveRequests`.
- **Suspension state** — TODAY `suspendedEmployees{code:{reason,suspendedOn,tgMsgIds,notified}}` in
  `localStorage.rsr_suspended` (per-device). **This build makes it DB-shared** (see the new
  "DB-shared suspension state" section); the local object is kept as a read-cache so downstream code
  (badges, block, modal) changes minimally.
- **Current block** — `punch()` ~2645: a *toast* (`showMsg`) only when a suspended worker taps Time In.
- **Current alert** — `sendAbsenceSuspensionAlert` → **manager DMs** (`mgr_ids`) with inline
  ✅ Reinstate / ❌ Keep buttons; callback handler at ~4218 (auth: `mgrIds.includes(fromId)` ~3952).
- **Reinstatement (3 paths)** — kiosk Admin ▸ Staff roster "✅ Reinstate" button (`renderRoster` ~4684);
  Telegram button callback (~4224); auto on leave approval (~3995). All call `reinstateEmployee(code)`.
- **Telegram config** — `settings` keys `tg_token,tg_group,tg_backup_group,tg_pos_group,tg_photo_group,
  mgr_ids` loaded by `loadTgFromCloud` (~5042). Message/edit helpers: `tgSendText`, `tgSendWithButtons`,
  `tgEditMessage`, `tgAnswerCallback`.
- **No letter infrastructure exists** — new.

## Design

### DB-shared suspension state (source of truth) — foundational
- **New table `public.employee_suspensions`** (RLS disabled, per project convention; anon read/write via
  PostgREST). One row per employee, reused across suspend/reinstate cycles:
  `employee_code text primary key`, `active boolean not null default true`, `reason text`,
  `suspended_on text`, `absent_dates jsonb` (the triggering run), `awol_group_msg_id text`,
  `awol_group_chat text`, `reinstated_by text`, `reinstated_on text`, `updated_at timestamptz default now()`.
  Unique key on `employee_code` gives cross-kiosk race safety.
- **Two atomic RPCs (security definer) for cross-device dedup:**
  - `awol_set_suspended(p_code, p_reason, p_dates jsonb, p_on) → boolean` — insert the row or flip an
    inactive row to `active`; returns **true only when it newly activated** (was not already active).
    Two kiosks detecting the same AWOL in the same run: exactly one gets `true` → exactly one alert.
  - `awol_reinstate(p_code, p_by, p_on) → jsonb` — flip an active row to inactive; returns
    `{newly:true, awol_group_msg_id, awol_group_chat}` when it newly reinstated, else `{newly:false}`.
    The returned msg id lets **any** device edit the original group alert to RESOLVED (reliable now).
- **Kiosk read path:** a poller (reuse the ~30–60 s cadence family already in the kiosk) refreshes the
  local `suspendedEmployees` cache from `employee_suspensions where active=true`. The PIN-entry modal,
  the punch block, and the Staff badges read that cache. **Best-effort live point-check at PIN entry:**
  if online, a fast single-row lookup by `employee_code` confirms freshness before showing the block;
  offline falls back to the cache. Net effect: cross-kiosk block within one poll interval (seconds), and
  immediate at the moment of a punch attempt when online.
- **Offline / transition:** writes go through the RPCs with a short retry; if a device is offline it uses
  the last cache and reconciles on reconnect. **One-time migration on first boot of this build:** upsert
  any existing `localStorage.rsr_suspended` entries into the table via `awol_set_suspended` (no alert
  re-fire — see below), so nobody currently suspended slips through the cutover.

### PART 1 — PIN-entry blocking modal
- **Hook:** `kp()`, immediately after identification (`showEmpPreview(emp)`), same spot as the sweep's
  dead-window modal. If `suspendedEmployees[emp.code]` → show a **blocking** Bisaya modal via the existing
  `showBisayaModal` (full-screen overlay), then the modal's dismiss clears the PIN (`kpClr`) and returns to
  the clock. **Exact text (owner-approved):**
  > **GI-SUSPEND ANG IMONG ACCOUNT**
  > Absent ka og 3+ ka adlaw nga sunod-sunod nga walay approved nga leave.
  > Adto sa admin/opisina aron ma-reinstate una ka maka-punch.
- **Fully blocks.** A suspended worker (3+ consecutive absent days) has no open shift by definition, so
  there is no Time-Out to preserve — the modal stops all punching. The existing Time-In toast (~2645)
  stays as a defense-in-depth backstop.

### Detection change — HOLD + flag on a pending leave
Extend `checkAllAbsences`. When an employee reaches `consecutive >= 3` and is not already suspended and not
on Approved leave today:
- Compute the **absent run's dates** (the consecutive dates that produced the count) — store them; the
  letter and the alert use exactly these.
- Check for a **Pending** leave overlapping any of those dates:
  `leaveRequests.some(r => r.code===emp.code && r.status==='Pending' && r.startDate<=d && r.endDate>=d)`.
  - **Pending overlap → HOLD.** Do not add to `suspendedEmployees`. Send a **one-time** note to the AWOL
    group: `⏸ <b>Pending leave — please decide</b> 👤 [Name] ([Code]) · 🏢 [Yard] — absent 3+ days but has
    a PENDING leave for [dates]. Approve or Reject para ma-clear.` Track a per-employee `awolPendingFlagged`
    marker (persisted) so it is not re-sent on every scheduled run. Clear the marker when the person no
    longer has an overlapping pending leave (approved → run clears; rejected → falls through to Suspend).
  - **No pending overlap → SUSPEND** (below).

### SUSPEND + PART 2/3 alert
On suspend: call `awol_set_suspended(code, reason, absentDates, todayKey())`. **Only if it returns `true`
(this device newly activated the suspension)** proceed to alert — this is the cross-kiosk dedup guard.
Refresh the local cache, then `sendAwolAlert(emp)`. *(The one-time cutover migration calls the same RPC
but skips `sendAwolAlert` — it is a state import, not a new event.)*
- **Build the letter URL** (PART 2):
  `<PAGES_BASE>/awol-letter.html?name=<Name>&code=<Code>&yard=<Yard>&dates=<iso,iso,...>&pdate=<todayISO>`
  (URL-encoded). `dates` = `absentDates`; `pdate` = suspension date.
- **Send to the AWOL group** (PART 3) — target `tgAwolGroup || <fallback>` (see Rollout):
  > 🚨 <b>AWOL — Account Suspended</b>
  > 👤 [Name] ([Code]) · 🏢 [Yard]
  > 📅 Absent: [dates] · Suspended: [date]
  > 📄 Printable letter: [letter URL]
  > [ ✅ Reinstate ] [ ❌ Keep Suspended ]
- After the send, persist the returned `message_id` + the group chat id onto the DB row
  (`update employee_suspensions set awol_group_msg_id=…, awol_group_chat=… where employee_code=…`) so any
  kiosk can later edit that exact message to RESOLVED. Button callbacks reuse the existing
  `approve_reinstate_*` / `reject_reinstate_*` handler + `mgrIds` auth (only authorized IDs can action;
  anyone can read the log).

### PART 2 — the printable letter page (`awol-letter.html`)
- **New standalone file at repo root**, served by GitHub Pages; no kiosk chrome, no dependency on Supabase
  at view time — it fills placeholders purely from **URL params** (`name, code, yard, dates, pdate`).
  Snapshot of the triggering event (exact dates that caused the suspension).
- **A4 print** — `@page{size:A4; margin:16mm}`; a screen-only dark action bar (`.screen-bar`, hidden via
  `@media print`) with a **Print / Save PDF** button; white sheet, serif body, letterhead rule.
- **Bisaya date formatting** in-page — `dates`/`pdate` accept ISO (`YYYY-MM-DD`) or `MM/DD/YYYY`; rendered as
  `Lunes, Hulyo 20, 2026` (weekday + Bisaya month). Multiple dates → bulleted list.
- **Content = owner-approved template verbatim:** letterhead `RSR ENGINEERING` + `[Yard]`; title
  *Pahibalo sa Pagpasabot ug Pagbalik sa Trabaho (Notice to Explain / Return-to-Work Order)*; Petsa;
  Para kang [Name] — [Code]; absent-dates list; AWOL explanation; `PAGPASABOT SA EMPLEYADO:` with 5
  handwriting rules; submit-to-admin paragraph; `Pahinumdom` reminder; three signature blocks
  (Empleyado / Admin+reinstate date / Coordinator). Generous spacing for hand-fill.
- Carries its own version stamp (in a header comment) for preflight.

### PART 3 — dedicated AWOL group + reinstatement log
- **New settings key `tg_awol_group`.** Add to `loadTgFromCloud`'s key list + a `tgAwolGroup` var + the
  `rsr_tg` localStorage cache. Owner sets its value after capturing the chat ID (below).
- **Closing message on EVERY reinstatement path.** The shared `reinstateEmployee(code)` (and the
  Telegram-callback reinstate at ~4224, and leave-approval auto-reinstate at ~3995) now call
  `awol_reinstate(code, who, todayKey())` **first**. Only when it returns `{newly:true}` (dedup guard, so a
  double-tap or a race between two kiosks posts the closing message once):
  1. **Post** to the AWOL group: `✅ <b>Reinstated</b> 👤 [Name] ([Code]) — by [who] on [date].`
  2. **Edit** the original alert to `✅ RESOLVED — [Name] reinstated [date]` using the
     `awol_group_msg_id` / `awol_group_chat` returned by the RPC — **reliable from any device now** (the
     ids live on the DB row, not per-device state).
  Then refresh the local cache so the block lifts. `who` = the Telegram actor's first name for TG
  reinstatements, `Admin (kiosk)` for the Staff-tab button, or `leave approved` for the auto path.
- **Chat ID capture (owner-side, non-disruptive):** create the group (e.g. "RSR AWOL Cases"); add the
  existing RSR bot; add **@RawDataBot** (or @getidsbot) — it posts JSON; read `chat.id` (negative;
  supergroups start `-100…`); remove @RawDataBot; set `settings.tg_awol_group` to that id (one-line SQL /
  REST upsert provided at build time). Kiosk picks it up via "↻ Reload Telegram from Admin" or reboot.
  *(This is done by the owner precisely so the build never has to touch the live bot's `getUpdates` offset.)*

## Reinstatement — exact tap path (owner asked)
On the kiosk: **(1)** long-press (~2s) the **app title** → 6-digit admin passcode → **(2)** long-press
(~2s) the **Stuck-punches card title** → section list → **(3)** tap **Staff** → **(4)** find the person
(🚫 Suspended badge) → tap **✅ Reinstate**. Or tap **✅ Reinstate** on the AWOL-group Telegram message
(authorized manager IDs only). Both post the closing message.

## Data / state model
- **Source of truth = `employee_suspensions`** (DB). Fields per the DB-shared section. No change to the
  `attendance_records` schema.
- **Local `suspendedEmployees`** is now a **read-cache** of `active=true` rows, refreshed by the poller and
  after every RPC call; kept in `localStorage.rsr_suspended` for offline reads. Each cached entry carries
  `absentDates` for anything that needs the triggering run.
- **HOLD marker** (`awolPendingFlagged`) stays lightweight: a small `awolPending{code:true}` map persisted
  in localStorage keyed to make the "please decide" note one-time; cleared when the overlapping Pending
  leave resolves. (Pure notification bookkeeping — not authoritative state, so it need not be DB-shared;
  worst case a rare duplicate note if two kiosks flag the same held case, acceptable. If we want it exact,
  a nullable `pending_flagged_on` column on the row + a third tiny RPC — noted as an optional tightening.)

## Harness scenarios (permanent, `tests/kiosk-stress`)
1. Suspended employee keys PIN → blocking modal shown (`modal=true`), punch blocked, PIN cleared.
2. 3 consecutive absences, **no** leave → suspended; AWOL alert composed with correct letter URL
   (name/code/yard/dates/pdate all present + URL-encoded).
3. 3 consecutive absences **with an overlapping Pending leave** → **not** suspended; HOLD note composed
   once; a second scheduled run does **not** re-send (one-time marker holds).
4. Pending leave then **Approved** → run clears, no suspension, marker cleared. Pending then **Rejected**
   → next run suspends.
5. Reinstate via each path → `awol_reinstate` returns `{newly:true}` once → closing message composed;
   original edited to RESOLVED using the DB-stored msg id. A second reinstate call returns `{newly:false}`
   → no duplicate post.
6. `tg_awol_group` **unset** → alert falls back to manager DMs (no silent drop); set → routes to group.
7. **Cross-device (two simulated kiosks A + B sharing the mocked DB):** A suspends → B's poll surfaces the
   row and B blocks the worker at PIN entry; B reinstates → A's poll clears the block. And: A + B both
   detect the same AWOL in one run → `awol_set_suspended` returns true to exactly one → exactly one alert.
8. Regression: non-suspended workers punch normally, no modal; existing sweep/OT scenarios still pass.

## Migration + rollout
- **SQL (new file `awol-suspensions.sql`):** STEP 0 census (existing `settings` keys; confirm no
  `employee_suspensions` table yet). STEP 1 create `employee_suspensions` + unique key + anon grants
  (RLS-disabled convention). STEP 2 the two RPCs (`awol_set_suspended`, `awol_reinstate`, security
  definer) + grants. STEP 3 additive upsert of the `tg_awol_group` settings key (value set by owner after
  chat-ID capture). STEP 4 re-query. No `attendance_records` change.
- **One-time cutover:** on first boot of this build the kiosk imports any local `rsr_suspended` entries via
  `awol_set_suspended` (alert suppressed), so current suspensions carry over to the shared table.
- **Graceful fallback:** `const awolTarget = tgAwolGroup || mgrIds-first-or-tgGroup;` — AWOL alerts never
  drop while the key is empty.
- **Version stamps:** bump `kiosk/index.html` to the next stamp + `preflight.html` EXPECT in lockstep; add
  `awol-letter.html` (with its stamp) to preflight EXPECT.
- **Deploy:** worker-facing + punch-blocking → **localhost walkthrough** (suspend a test employee, verify
  the PIN modal, the AWOL-group alert + letter render, reinstate + closing message) → explicit "push".
  Tablets need `reset.html` after deploy.

## Scope exclusions / known constraints
- **Payroll untouched.** Suspension is attendance-gating only; no pay math changes.
- **Suspension state is DB-shared** (`employee_suspensions`) — a worker is blocked at every kiosk and
  reinstatement clears everywhere. Cross-kiosk block latency = one poll interval (seconds), plus an
  immediate online point-check at the punch attempt; offline uses the last cache. Detection itself stays
  **client-side** (as it exists today) with RPC-level dedup — a server-side (pg_cron) detector is a
  possible future move, out of scope here.
- **Cross-device original-message edit is now reliable** (msg id + chat id live on the DB row).
- **Bot token is anon-readable** (parked security item, tracked separately) — this feature adds no new
  exposure; it reuses the existing token/helpers.
- **No RSR Admin dashboard reinstate control** (owner chose keep-as-is).

See [[full-day-timein-gate-spec]] (the queued follow-up this precedes), [[7pm-sweep-spec]] (the
`showBisayaModal` + PIN-entry hook this reuses), [[migrate-punch-notifications-serverside]] (bot-token
hardening), [[harden-kiosk-admin-gate]] (the admin unlock + Staff section this reinstatement path lives in).
