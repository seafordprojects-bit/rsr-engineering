# Named issuer access for Tool Borrow + Material Issuance

**Date:** 2026-07-19
**Status:** Approved design (owner approved 2026-07-19, incl. idle auto-lock). Ready for implementation plan.

## Goal

Replace the single shared site passcode that gates the Tools page and Material Issuance with a
per-person unlock: an authorized **issuer** enters their own 6-digit employee PIN, the page unlocks,
and every slip made in that session is **auto-stamped** with the issuer's name. Issuance becomes
possible anytime (not just 8 AM–5 PM while one person holds the passcode), with per-person
accountability. Who can issue is admin-managed data. The shared passcode is retired.

## Business rules (owner-confirmed)

- Authorized issuers are **employees flagged as issuers** in an admin list. All issuers have equal
  power. The list has no fixed size — add/remove over time entirely from the admin card.
- To unlock Tools or Material Issuance, an issuer enters their **own existing 6-digit employee PIN**
  — no separate issuer passcode. A valid employee who is NOT an issuer must not unlock. A wrong PIN
  must not unlock.
- Whoever unlocks is **automatically the issuer for that session** — "Issued by" comes from the PIN
  identity, never free text, never editable. Applies to borrow, repair, transfer, ship-repaired, and
  material issuance.
- **Idle auto-lock:** after ~10 minutes with no activity the session locks back to the PIN screen and
  the issuer is cleared; the next action needs a PIN again. Any interaction resets the timer.
- Slips AND the issuance lists show the issuer's name — "who released this and when" is always
  answerable.
- Everything else unchanged: the borrower/crew still accepts with their **own** PIN (`verify_pin`),
  server-only slip numbers, the double-issue guard, per-page English wording.
- Retire the shared issuance passcode once this works; flag every other place it is used first.

## Current state (from code exploration)

- **Shared-passcode gate:** `tools/index.html:416–425` (`savedPin()`/`doLogin()`, `#s-login` 4-digit
  keypad at :94, footer "Default PIN: 1111" at :110) and `material-issuance/index.html:259–269`
  (`#login-pin` text box, boots `issuancePin` default `'1111'`). Both read `settings.issuance_pin`
  (fallback `1111`); "authorized" == the `#s-home` screen is shown. No session token, **no idle lock**.
- **Shared passcode is also set** in Admin: `home.js:739–743` `saveSitePin()`, card at
  `home.js:1519–1526`. **One more reader:** `app.js:849–858`, loaded ONLY by the orphaned
  `borrower-equipments/index.html` (docs: do not revive — nothing links to it).
- **"Issued by" is free text everywhere** — five write sites, each fed by a text input:
  | Action | Input | Insert/Update | Field |
  |---|---|---|---|
  | Borrow | `#bw-by` | `borrow_issuance` insert (`tools:700`) | `issued_by` |
  | Repair | `#rp-by` | `repair_log` insert (`tools:892`) | `transmitted_by` |
  | Transfer out | `#tf-by` | `tool_transfers` insert (`tools:1120`) | `sent_by` |
  | Ship-repaired (same site) | `#rback-by` | `repair_log` update (`tools:931`) | `received_back_by` |
  | Ship-repaired (other site) | `#rback-by` | `repair_log` update (`:931`) + `tool_transfers` insert (`:937`) | `received_back_by` + `sent_by` |
  | Material issuance | `#i-by` | `issuances` insert (`material:417`) | `by_name` |
- **PIN identity:** `employees.pin` (plaintext text). `verify_pin(emp_id, pin_input)→bool` verifies a
  KNOWN employee. There is **no "find employee by PIN"** capability server-side — only the kiosk's
  client-side `findEmp` (`kiosk:1100`) against the in-browser roster. Both issuance pages currently
  select `pin` into the browser (`tools:512`, `material:277`) but **do not use it** (verification goes
  through the RPC).
- **Admin employee card:** `home.js:1600–1636` (employee `<select>`, PIN input, `saveEmp` →
  `updateEmployee(id, fields)` at `:240` which accepts arbitrary fields). `getEmployees()` select at
  `home.js:28–33`. No issuer flag exists.

## Design

### Data model (owner runs the SQL)

1. **`employees.is_issuer boolean default false`** — additive column. Existing rows default `false`.
2. **`issuer_for_pin(pin_input text)` RPC** — server-side identity lookup. Returns the issuer's
   `id, name` when an **active issuer** has that PIN, else no row. Never returns the PIN. This is why
   the unlock is server-side: we do not rely on shipping every PIN to the browser, and the issuance
   pages **stop selecting `pin`** (currently fetched-but-unused → removed, a small security win).
   ```sql
   create or replace function public.issuer_for_pin(pin_input text)
   returns table(id uuid, name text)
   language sql stable security definer as $$
     select id, name from public.employees
     where is_issuer = true and pin is not null and pin = pin_input
     limit 1;
   $$;
   ```
3. **Seed the 3 initial issuers:** `update public.employees set is_issuer = true where code in (…)`
   for **Jamaica L. Batucan** (assistant), **Alvin H. Operio** (foreman), **Ritchie Lawan**
   (roll-call in-charge). Their exact `code`s are resolved against the live roster when the migration
   is written, so the seed cannot silently miss on a name mismatch.

### A. Issuers admin card (`home.js`)

A dedicated **"Issuers"** card in the admin settings column (near the retired passcode card): a
picker to add an employee as an issuer, and a list of current issuers each with **Remove** (Remove =
deactivate = `is_issuer=false`). Reuses the existing `getEmployees()` (add `is_issuer` to the select)
and `updateEmployee(id, {is_issuer})` — no new CRUD plumbing.

### B. Unlock by employee PIN (both pages)

- **Tools:** the `#s-login` keypad accepts a **6-digit** PIN (was 4). On 6 digits → `sb.rpc(
  'issuer_for_pin', {pin_input})`. A returned row → unlock (`boot()`), and store the session issuer
  `{id, name}` (module var + a session marker). No row → "Not an authorized issuer" error, clear pad.
- **Material issuance:** the `#login-pin` box takes the 6-digit PIN → same RPC → unlock; else the
  same error.
- The shared-passcode check (`savedPin`/`issuancePin`) is removed from both.

### C. Auto-stamp + Sign out handoff

- The five free-text inputs (`#bw-by`, `#rp-by`, `#tf-by`, `#rback-by`, `#i-by`) are **removed**;
  each write site is set from the **session issuer name** (`issued_by`, `transmitted_by`, `sent_by`,
  `received_back_by`, `by_name`).
- The page header shows **"Issuer: <name>"** prominently; a **Sign out** control returns to the PIN
  screen and clears the issuer, so a different issuer takes over by entering their own PIN.
- Borrower/crew acceptance via their own PIN (`verify_pin`) is unchanged.

### D. Lists show the issuer

The borrowed-now / records / repair / transfer / material-issuance lists render the issuer name
(the stored `issued_by`/`sent_by`/`transmitted_by`/`by_name`) so every record answers "who released
this and when."

### E. Idle auto-lock (both pages)

A ~10-minute inactivity timer. Any tap/keypress/input resets it (a single document-level listener +
`setTimeout`). On expiry: clear the session issuer and return to the PIN screen (same as Sign out).
`const IDLE_MS = 10*60*1000`.

### F. Retire the shared passcode

- Remove the `issuance_pin` check and the "Default PIN: 1111" footer from `tools/index.html` and
  `material-issuance/index.html`.
- Remove the "Issuance (site) passcode" admin card + `saveSitePin` + `sitePin` state from `home.js`.
- **Flagged, left as-is:** `app.js` still reads `issuance_pin`, but it is used ONLY by the orphaned
  `borrower-equipments/` page nothing links to — not retired here (out of scope), noted in the plan.
- Update docs that mention the issuance passcode for accuracy.

## Language

Both pages stay **English** (in-charge operated). New strings: "Enter your PIN", "Not an authorized
issuer", "Issuer: <name>", "Sign out", the Admin "Issuers" card labels — all English.

## Testing (Playwright E2E)

1. **Unlock:** an issuer's PIN unlocks (RPC returns a row); a valid non-issuer PIN is refused; a wrong
   PIN is refused. On both pages.
2. **Auto-stamp:** each slip (borrow, repair, transfer, ship-repaired, material issuance) writes the
   **session issuer's name** to its by-field — no free-text input exists; the value is not editable.
3. **Idle lock:** after the idle timeout the page returns to the PIN screen and the issuer is cleared
   (test with a shortened timeout injected, or by asserting the timer wiring).
4. **Sign out** returns to the PIN screen and clears the issuer.
5. **Retirement:** the old `issuance_pin` no longer unlocks either page; the passcode admin card is gone.
6. **Admin:** toggling an employee in the Issuers card writes `is_issuer`; a removed issuer's PIN no
   longer unlocks.
7. **Lists** show the issuer name.

## Deploy / constraints

- Owner runs the `ALTER` + `issuer_for_pin` RPC + the seed `UPDATE` before deploy; re-verify the
  column/function/flags independently.
- Supabase project `wpmcbjrisuyjvobvzaus` only; hygiene grep every deliverable.
- htm/innerHTML per each page's existing style; validate (`node --check`) + full regression.
- Worker/inventory-affecting → **walkthrough before push**.

## Out of scope

Retiring `app.js`/`borrower-equipments` (orphaned). Any change to `verify_pin` or the borrower/crew
acceptance flow. Bilingual strings.
