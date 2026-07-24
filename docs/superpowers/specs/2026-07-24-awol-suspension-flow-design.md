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

## Goal
Turn the existing (already-working) AWOL suspension **detection** into a complete, humane, auditable flow:
a worker learns at PIN entry that they're suspended and what to do; the coordinator gets an automatic
alert with a **printable letter** to hand-fill at the yard; and all AWOL cases live in one Telegram group
that reads as a running log of open vs resolved.

## What already exists (reused, not rebuilt)
- **Detection** — `checkAllAbsences()` (kiosk) runs on the midnight/boot schedule. `getConsecutiveAbsences`
  counts backward from yesterday; `isAbsentOnDate` = *no Time-In AND no Approved leave* that date. Suspends
  at `>= 3`. Client-side, off cloud-synced records + `leaveRequests`.
- **Suspension state** — `suspendedEmployees{code:{reason,suspendedOn,tgMsgIds,notified}}`, persisted to
  `localStorage.rsr_suspended` (per-device; see Known constraints).
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
On suspend: set `suspendedEmployees[emp.code] = {reason, suspendedOn, absentDates, tgMsgIds:{}, notified:false}`,
`saveData()`, then `sendAwolAlert(emp)`:
- **Build the letter URL** (PART 2):
  `<PAGES_BASE>/awol-letter.html?name=<Name>&code=<Code>&yard=<Yard>&dates=<iso,iso,...>&pdate=<todayISO>`
  (URL-encoded). `dates` = `absentDates`; `pdate` = suspension date.
- **Send to the AWOL group** (PART 3) — target `tgAwolGroup || <fallback>` (see Rollout):
  > 🚨 <b>AWOL — Account Suspended</b>
  > 👤 [Name] ([Code]) · 🏢 [Yard]
  > 📅 Absent: [dates] · Suspended: [date]
  > 📄 Printable letter: [letter URL]
  > [ ✅ Reinstate ] [ ❌ Keep Suspended ]
- Store the returned `message_id` in `suspendedEmployees[emp.code].tgMsgIds[<awolGroupId>]` so it can be
  edited to RESOLVED on reinstatement. Button callbacks reuse the existing `approve_reinstate_*` /
  `reject_reinstate_*` handler + `mgrIds` auth (only authorized IDs can action; anyone can read the log).

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
- **Closing message on EVERY reinstatement path.** Wrap the shared `reinstateEmployee(code)` (and the
  Telegram-callback reinstate at ~4224, and leave-approval auto-reinstate at ~3995) so that on reinstate:
  1. **Post** to the AWOL group: `✅ <b>Reinstated</b> 👤 [Name] ([Code]) — by [who] on [date].`
     (Always sends — needs only group id + token, which every device has → reliable.)
  2. **Best-effort edit** the original alert to `✅ RESOLVED — [Name] reinstated [date]` if this device
     holds the stored `message_id` (per-device; degrades cleanly if not).
  “by [who]” = the Telegram actor's first name for TG reinstatements, or `Admin (kiosk)` for the Staff-tab
  button, or `leave approved` for the auto path.
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
`suspendedEmployees[code]` gains: `absentDates:[iso,...]` (the triggering run) and `tgMsgIds` now keyed by
the AWOL group id. New per-employee marker `awolPendingFlagged` (in `suspendedEmployees` shadow or a small
`awolPending{}` map) to make the HOLD note one-time. All persist through the existing `saveData` /
`rsr_suspended` path — no schema change to attendance.

## Harness scenarios (permanent, `tests/kiosk-stress`)
1. Suspended employee keys PIN → blocking modal shown (`modal=true`), punch blocked, PIN cleared.
2. 3 consecutive absences, **no** leave → suspended; AWOL alert composed with correct letter URL
   (name/code/yard/dates/pdate all present + URL-encoded).
3. 3 consecutive absences **with an overlapping Pending leave** → **not** suspended; HOLD note composed
   once; a second scheduled run does **not** re-send (one-time marker holds).
4. Pending leave then **Approved** → run clears, no suspension, marker cleared. Pending then **Rejected**
   → next run suspends.
5. Reinstate via each path → closing message composed for the AWOL group; original edited to RESOLVED when
   the msg id is present.
6. `tg_awol_group` **unset** → alert falls back to manager DMs (no silent drop); set → routes to group.
7. Regression: non-suspended workers punch normally, no modal; existing sweep/OT scenarios still pass.

## Migration + rollout
- **SQL:** STEP 0 read the existing `settings` keys, then additive upsert of `tg_awol_group` (value set by
  owner after chat-ID capture). No attendance-table change.
- **Graceful fallback:** `const awolTarget = tgAwolGroup || mgrIds-first-or-tgGroup;` — AWOL alerts never
  drop while the key is empty.
- **Version stamps:** bump `kiosk/index.html` to the next stamp + `preflight.html` EXPECT in lockstep; add
  `awol-letter.html` (with its stamp) to preflight EXPECT.
- **Deploy:** worker-facing + punch-blocking → **localhost walkthrough** (suspend a test employee, verify
  the PIN modal, the AWOL-group alert + letter render, reinstate + closing message) → explicit "push".
  Tablets need `reset.html` after deploy.

## Scope exclusions / known constraints
- **Payroll untouched.** Suspension is attendance-gating only; no pay math changes.
- **Per-device suspension state** (existing `localStorage` model) is **not** re-architected here. In
  practice each worker punches at their home-yard tablet, so the block lands where it matters; a
  DB-shared `suspended` table is a possible future hardening, out of scope for this build.
- **Cross-device original-message edit** is best-effort (msg id is per-device); the *closing post* is
  always reliable. Acceptable — the log still shows open→resolved.
- **Bot token is anon-readable** (parked security item, tracked separately) — this feature adds no new
  exposure; it reuses the existing token/helpers.
- **No RSR Admin dashboard reinstate control** (owner chose keep-as-is).

See [[full-day-timein-gate-spec]] (the queued follow-up this precedes), [[7pm-sweep-spec]] (the
`showBisayaModal` + PIN-entry hook this reuses), [[migrate-punch-notifications-serverside]] (bot-token
hardening), [[harden-kiosk-admin-gate]] (the admin unlock + Staff section this reinstatement path lives in).
