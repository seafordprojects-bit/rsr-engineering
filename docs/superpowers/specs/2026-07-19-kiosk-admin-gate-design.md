# Kiosk Admin gate — server-side passcode (2026-07-19)

## Problem / current state
- Kiosk `adminLogin()` has been **disabled** since ~2026-07-07 (`return; // disabled in
  kiosk-only mode`). The `admin123` default and the localStorage password path
  (`adminPassword`, save at ~:3883, load at ~:4014, `changePassword`) are **dead code** —
  nothing checks them.
- There is **no Admin tab** and `showATabs()` (which reveals the Settings tab) is only called
  by the disabled login, so **Admin/Settings are unreachable** in the deployed build.
- Consequence: the **"Stuck punches" recovery card** shipped in v2026-07-19c lives in the
  Settings tab and is therefore **not reachable** on a tablet running the current build. This
  design fixes that as part of re-enabling Admin.

Owner confirmed (2026-07-19): tablets are punch-only today; Admin is not used on them, so
re-enabling Admin behind a passcode adds capability without disrupting current workflow.

## Goal
Replace the (dead) client-side per-device `admin123` password with a **single server-side
admin passcode**, verified via a Supabase RPC modeled on the `issuer_for_pin` pattern
(`security definer`, never echoes the secret). One passcode valid on every device. Re-enable
Admin with a hidden entry point, and make the stuck-punches card reachable again.

## Supabase (SQL the owner runs once, in the SQL editor)
Additive + idempotent. Uses `pgcrypto` bcrypt; the DB stores only a hash.

- Extension: `create extension if not exists pgcrypto;`
- Table (single row, hash not exposed to the anon REST role):
  `kiosk_admin_credential(id boolean primary key default true check (id), passcode_hash text
  not null, updated_at timestamptz not null default now())`.
  **`revoke all on kiosk_admin_credential from anon, authenticated;`** — even though the
  project runs RLS-disabled, this table must NOT be REST-readable, or the hash leaks. The
  `security definer` RPCs still read it (they run as the definer/owner).
- `admin_verify_passcode(p_input text) returns boolean` — `security definer`, `stable`.
  `select exists(select 1 from kiosk_admin_credential where passcode_hash = crypt(p_input,
  passcode_hash))`. Returns false if unset. Never returns the hash.
- `admin_bootstrap_passcode(p_new text) returns text` — `security definer`. **Fails if a
  passcode already exists** (`raise exception`), so it can never silently overwrite; requires the
  PIN to be **exactly 6 digits** (`^[0-9]{6}$`). Inserts the single row with
  `extensions.crypt(p_new, extensions.gen_salt('bf'))`. This is the one-time first-set the owner
  runs with their chosen 6-digit PIN in a placeholder.
- pgcrypto lives in Supabase's `extensions` schema; every `crypt`/`gen_salt` call is
  **schema-qualified** (`extensions.crypt(...)`) rather than widening the functions' `search_path`.
- `admin_change_passcode(p_current text, p_new text) returns boolean` — `security definer`.
  Verifies `p_current` against the stored hash; on match, updates to the new hash and returns
  true; returns false if the current passcode is wrong. This is the ongoing rotation path.
- `grant execute` on the three functions to `anon, authenticated` (the kiosk uses the anon key).

The SQL file (`kiosk-admin-gate.sql`) contains a clearly-marked `__SET_YOUR_PASSCODE_HERE__`
placeholder for the bootstrap call, and a header comment reminding the owner NOT to save the
file with the real passcode after running it.

## Kiosk client changes
1. **Re-enable `adminLogin()`** to verify server-side:
   `const ok = await sbClient.rpc('admin_verify_passcode', { p_input: pw })` → on `ok.data ===
   true` unlock (existing unlock body: show admin-content, `showATabs()`, timer); on false show
   "Incorrect passcode"; on thrown error / offline show the **fail-closed** message.
2. **Offline = fail-closed** (decided): if the RPC can't reach Supabase, Admin does NOT unlock
   ("Admin needs internet to verify — cannot unlock offline."). Punching is unaffected (it
   already works offline and queues). Rationale: Admin is management-only and not time-critical
   during an outage; trusting a cached/guessable local check would defeat the hardening.
3. **Hidden entry point**: long-press the app title (`#app-title-el`) ~2s (pointer/touch down →
   timer; up/leave/cancel → clear) opens the Admin PIN screen (`tab-admin`, `admin-lock`
   visible, `admin-content` hidden), focuses the input. English text on this screen (owner-
   facing); all worker-visible text stays Bisaya as usual.
4. **10s idle auto-dismiss**: on the Admin PIN screen, no input for ~10s returns to the Clock
   tab, so an accidental long-press never strands a worker. Any keystroke resets the timer.
5. **Brute-force guard**: lock the passcode entry after **5 wrong attempts** (mirrors the
   existing kiosk PIN-lockout), so the boolean verify RPC isn't a free oracle. A strong passcode
   plus client lockout is the pragmatic bar (no per-caller server state available).
6. **Remove dead password path**: delete the `admin123` default, drop `adminPassword` from the
   settings save/load, and remove the localStorage `changePassword`. The in-panel "Change
   passcode" UI calls `admin_change_passcode(current, new)`.
7. **Stuck-punches reachable**: with Admin re-enabled, Admin ▸ Settings (and the stuck-punches
   card) opens normally again.
8. Bump the page version stamp and the `preflight.html` EXPECT in lockstep.

## Scope exclusions (separate items, not this change)
- The assistant login (`loginAssistant`, `assist123`) stays disabled/unchanged.
- The broader unescaped-`innerHTML` hardening pass in other render functions (tracked
  separately) is not part of this change.

## Security notes
- The hash is never returned by any RPC and the table is not REST-readable (explicit revoke).
- `admin_verify_passcode` is a boolean oracle callable with the public anon key. The client-side
  5-try lockout only protects the KIOSK UI path — it does NOT stop an attacker calling the RPC
  directly with the public anon key. With an **exactly-6-digit numeric** PIN that is a 1,000,000-
  key space, brute-forceable via direct API calls. This is an accepted tradeoff (6-digit numeric
  matches the kiosk keypad and the worker-PIN model), flagged to the owner 2026-07-20. **Follow-up
  (recommended):** add a server-side throttle (a small attempts/locked-until table checked inside
  `admin_verify_passcode`) to blunt direct-RPC brute force — deferred, needs its own design
  (global vs per-caller lockout has a DoS tradeoff).
- Bootstrap cannot overwrite an existing passcode; rotation always requires the current one.

## Rollout & validation
1. Owner runs `kiosk-admin-gate.sql` (with their passcode in the placeholder), then discards the
   filled-in file.
2. Validate: `node --check` on the largest inline script; hygiene grep
   (`wpmcbjrisuyjvobvzaus` present, `azfmpleswqixaslvcito` absent).
3. Stress-harness regression run (admin change must not affect punch/sync tests) + a small
   admin-auth probe that mocks the three RPCs (verify true/false, offline fail-closed, lockout
   after 5, long-press entry, 10s auto-dismiss).
4. **Localhost walkthrough with the owner before any push** (worker-facing + pay-adjacent).
5. After push: tablets update via `reset.html`; confirm the stamp via `preflight.html`.
