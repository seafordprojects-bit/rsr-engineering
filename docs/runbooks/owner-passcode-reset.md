# Runbook — Owner passcode reset (break-glass)

**Purpose:** how to reset the **owner passcode** when the normal in-app path isn't
usable. The break-glass path is a direct edit of the Supabase `settings` table and is
the documented fallback — nothing else can reset it without app access.

> **Project:** `wpmcbjrisuyjvobvzaus` **only** (RLS disabled). Never point this at the old
> abandoned Supabase project (the one CLAUDE.md bans) — any URL containing it is a bug.

---

## What the "owner passcode" is

- Stored in the `settings` table as the row **`key = 'owner_pin'`**, `value` = the passcode
  as a **plain string** (e.g. `1234`). The `settings` table shape is `{ id, key, value }`.
- It has **no default** — if the row is missing, every owner action is blocked with
  `OWNER_PIN_NOT_SET` ("Set the owner passcode first").
- It is **checked live from the database on every use** (`checkOwnerPin` → `getSetting('owner_pin')`,
  in `monitoring/config.js` and `home.js`). There is **no cache** — a DB change takes effect
  immediately, no reload or re-login needed.
- It gates the **owner-only actions**, not merely opening a page:
  - set the incentive rate (`setIncentiveRate`)
  - Stage-2 job **incentive approval** (`approveJob`)
  - **reopen** a closed job (`reopenJob`)
  - owner-gated employee edits on the dashboard
- Every legitimate change is logged to **`settings_audit`** (`{ key, action, actor, at }`)
  with `action = 'set'` (first time) or `'change'`.

> The dashboard **entry** lock is a *different* secret: a device-local PIN in
> `localStorage[PIN_KEY]`, default `1234`. It is **not** `owner_pin` and is **not** in the
> database — see the table at the bottom. Forgetting the entry PIN is a device reset, not a
> SQL reset.

---

## Normal path (do this first)

Dashboard → **Settings** → **Owner passcode (incentive approval)** card → *Set / change owner
passcode*. This calls `setOwnerPin`, which writes `owner_pin` **and** appends the `settings_audit`
row for you. The card does not ask for the old passcode, so as long as you can open the
dashboard (device entry PIN, default `1234`) you can reset the owner passcode here without the
break-glass.

Use the break-glass below only when the dashboard UI itself is unavailable (can't load it,
Supabase JS blocked, locked out of the device, etc.).

---

## Break-glass: reset `owner_pin` via SQL

Run in the **Supabase SQL editor** (project `wpmcbjrisuyjvobvzaus`). This sets the passcode to a
known temporary value, then you change it to a real secret in the app.

```sql
-- 1) Set the owner passcode to a known temporary value.
--    insert-if-absent then update: works whether or not the row exists, and does
--    not assume a UNIQUE constraint on settings.key.
INSERT INTO settings (key, value)
SELECT 'owner_pin', '0000'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'owner_pin');

UPDATE settings SET value = '0000' WHERE key = 'owner_pin';

-- 2) Preserve the audit trail the app would normally write.
INSERT INTO settings_audit (key, action, actor)
VALUES ('owner_pin', 'break-glass-reset', 'DB admin — <your name>');

-- 3) Verify.
SELECT key, value FROM settings WHERE key = 'owner_pin';
SELECT key, action, actor, at
FROM settings_audit WHERE key = 'owner_pin'
ORDER BY at DESC LIMIT 3;
```

**Notes**
- Store the value as a **plain string** (`'0000'`), *not* a JSON-quoted string (`'"0000"'`).
  The app compares `String(entered) === String(value)`; a stored `"0000"` would fail to match.
- Because the check is live, `0000` works the instant the `UPDATE` commits.
- **Immediately** afterward, open the dashboard and change the passcode from `0000` to a real
  secret via the Owner-passcode card. That re-audits it as a normal `change` and gets the
  temporary value out of the system.

---

## Related passcodes (so this doesn't get confused with the others)

All the **DB-backed** ones live in the same `settings` table and reset the same way
(`UPDATE settings SET value = '<new>' WHERE key = '<key>';`, with the insert-if-absent guard
when the row may not exist yet).

| Passcode | Gates | Where it lives | Reset |
|---|---|---|---|
| **`owner_pin`** | Dashboard owner actions (incentive rate, job approve/reopen, employee edits) | `settings` (DB, no default, **live**-checked) | Owner-passcode card, or the SQL above |
| Dashboard **entry** PIN | Opening the dashboard on a device | `localStorage[PIN_KEY]`, default `1234` — **device-local, not in DB** | Change on the device; clearing storage reverts to `1234` |
| `coordinator_pin` | Coordinator / assistant app | `settings` (DB) | Dashboard → Assistant passcode, or `UPDATE settings SET value='…' WHERE key='coordinator_pin';` |
| `issuance_pin` | Material-issuance app | `settings` (DB; may not exist yet) | Dashboard → Issuance passcode, or insert-if-absent + update on `key='issuance_pin'` |
| Payroll passcode | Payroll app: unlock, Edit-times, week close, settings | `settings` row **`payroll_cfg`** — a JSON blob; the passcode is its `.pin` field (default `1234` from localStorage until first Settings save creates the row) | Payroll → Settings → *Change payroll passcode*, or the JSON-merge SQL below |
| Kiosk `admin_password` / `assistant_password` | Kiosk Admin / Assistant panels | The kiosk gate reads its **device-local** copy (`localStorage['rsr_settings']`); rows also exist in `settings` but are not the kiosk's source of truth | Kiosk Admin → change password (device-local). A DB edit will **not** reliably change the kiosk gate. |

### Payroll passcode is a JSON blob — reset it like this

```sql
-- Reset ONLY the pin inside payroll_cfg, preserving the other payroll settings.
INSERT INTO settings (key, value)
SELECT 'payroll_cfg', '{"pin":"1234"}'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'payroll_cfg');

UPDATE settings
SET value = (value::jsonb || '{"pin":"1234"}'::jsonb)::text
WHERE key = 'payroll_cfg';
```

Payroll caches `cfg` in `localStorage['rsr_payroll_settings']`, but on each **online** page load
`loadCfg` merges the DB value over the local one (DB wins) — so reload the payroll page online
for the reset to take effect, then change it via Payroll → Settings.

---

## Verification checklist

- `SELECT value FROM settings WHERE key='owner_pin'` returns the temporary value.
- A fresh `settings_audit` row exists for `owner_pin` (so the reset is on the record).
- An owner action (e.g. open the incentive-approval prompt) accepts the temporary passcode.
- The temporary passcode has been **changed to a real secret** in the dashboard afterward.
