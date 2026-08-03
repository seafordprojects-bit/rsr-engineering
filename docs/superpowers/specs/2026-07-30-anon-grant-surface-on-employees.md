# Spec — the anon grant surface on `public.employees`

**Raised:** 2026-07-30, from the Defect C/D/F work. The `is_non_punching` guard exposed it.
**Status:** written, NOT started. Do not fold into any in-flight change.
**Pairs with:** the plaintext-PIN item parked in
`2026-07-30-awol-detector-preconditions-and-defects-rev2.md` §12. Same column, same root cause,
and neither is fixable without the other.
**Blocks:** nothing yet. But every PIN-gated control in the disciplinary workflow depends on it.

---

## 0. Read this before adding detail to this file

**This repository is public** and `supabase.js` ships the anon key in client-side JavaScript on
GitHub Pages. So this document describes a live, reachable weakness in a public place.

It is written deliberately as *what is exposed and what the fix is*, with no request shapes, no
worked example and no reproduction steps. **Keep it that way.** Anyone extending this file should
add remediation detail, not exploitation detail. If a proof-of-concept is ever needed to convince
someone, it belongs in a private note, not here.

The exposure is pre-existing and was not created by this document.

---

## 1. The finding

`anon` holds **table-level `UPDATE`** on `public.employees`. Confirmed by the owner from
`information_schema.table_privileges` on 2026-07-30. It was never granted in any tracked SQL file —
`grep -rn "grant .* employees" *.sql` returns nothing — so it is a Supabase default or was applied
by hand and never recorded.

In PostgreSQL a table-level grant cannot be narrowed by revoking individual columns. So the grant
covers **every column, including ones nothing in the application ever writes.**

The live table has **24 columns** today. Defect C/D/F adds three more (`is_non_punching`,
`non_punching_set_by`, `non_punching_set_at`), taking it to 27 — all of them inside the same grant.

## 2. Why this matters more than it looks

`employees.pin` is in the grant.

Every PIN-gated control this system relies on — the admin passcode keypad, the AWOL clerk's
letter-received step, `awol_set_barred`, `set_non_punching`, `leave_decide`, the issuer unlock —
authenticates against a value stored in a column that is writable without authentication.

The disciplinary workflow's defensibility under DO 147-15 rests on being able to show that a named
person, identified by PIN, took a specific action at a specific time. **That chain currently
terminates in an unauthenticated field.** A PIN is not evidence of who acted if the PIN itself can
be set by anyone.

`daily_rate` is in the grant too, which makes it pay-adjacent as well as disciplinary-adjacent.

This is why it pairs with the plaintext-PIN item rather than being a separate concern: hashing the
PIN without fixing the grant leaves the hash rewritable, and fixing the grant without hashing
leaves it readable. Either alone is half a fix.

## 3. What each column exposes

Grouped by consequence, not by table order.

| Column | If writable by anyone |
|---|---|
| `pin` | **Impersonation of any PIN-gated action, including the owner's.** The whole audit chain. |
| `daily_rate` | **Pay.** Silent, and payroll would compute correctly from a wrong number. |
| `vl_balance`, `sl_balance` | Leave entitlement — money adjacent, and `leave_decide` deducts from it |
| `is_awol_clerk` | Who may perform the letter-received step. Self-appointment. |
| `is_issuer` | Who may issue tools and materials |
| `is_suspended` | Currently enforced nowhere, but named as if it were |
| `employment_type`, `type_effective_from` | AWOL exemption and the absence-scan floor |
| `is_non_punching` *(new)* | AWOL exemption. **Trigger-guarded as of Defect C/D/F — the only one that is.** |
| `separated_at`, `separated_by`, `separated_reason` | Employment status; interacts with lifecycle retirement |
| `home_site` | Yard assignment; feeds allowance and the Defect D site gate |
| `started_on` | The absence-scan floor (Defect A) |
| `code`, `code_norm` | **Identity.** `code_norm` is generated, but `code` drives every join in the system |
| `name`, `dept`, `position`, `phone`, `network`, `shift` | Records and notifications |
| `id`, `created_at` | Should never be client-written at all |

Nothing in that list is harmless. The closest to it — `phone` — is where absence notices are sent.

## 4. What the narrowed grant should be

The mechanics: `revoke update on public.employees from anon, authenticated;` then
`grant update (…) on public.employees to anon, authenticated;` naming only the legitimate columns.

**The blast radius is live production and the enumeration must be exact.** Deployed `main` writes to
this table from three surfaces:

| Surface | Sites (deployed `main`) |
|---|---|
| `coordinator.js` | `:27` INSERT, `:33` INSERT, `:37` UPDATE — personnel form |
| `home.js` | `:44`, `:185`, `:188`, `:240` UPDATE — salary, PIN assignment, balances, issuer flag |
| `kiosk/index.html` | `:5268`, `:5270` UPDATE, `:5272` INSERT — employee sync |

**The write helpers are generic**, which is the real obstacle:

```js
async function updateEmployee(id, fields) { await supabase.from('employees').update(fields).eq('id', id); }
```

The column set is decided by each *caller*, not the helper, so it cannot be read off the write site.
Callers found so far include `coordinator.js:424` and `home.js:1249`, `:1265`, `:1275`, `:1931`.

Columns named in write payloads across the three live surfaces, from a first pass:

```
code  code_norm  daily_rate  dept  home_site  id  is_issuer  is_suspended  name
network  phone  pin  position  shift  sl_balance  started_on  vl_balance
```

**Treat that list as a starting point, not the answer.** A column missed from the re-grant becomes a
silent write failure on a live personnel or payroll screen — and `updateEmployee` at
`coordinator.js:37` does throw, but `home.js:1249`-style callers wrap in `try` and flash a message,
so some failures would surface as a toast nobody reads.

**Required before implementing:**

1. Enumerate every caller of both `updateEmployee` helpers and every insert payload, and derive the
   exact union of written columns. Mechanical, and it must be complete rather than sampled.
2. Decide per column whether a *client* should write it at all, or whether it belongs behind a
   `security definer` RPC. Strong candidates for RPC-only: `pin`, `daily_rate`, `vl_balance`,
   `sl_balance`, `is_awol_clerk`, `is_issuer`, `employment_type`, `type_effective_from`,
   `separated_*`. That is most of the consequential list.
3. `id`, `created_at` and `code_norm` should be in no client grant. `code_norm` is generated;
   writing `id` or `created_at` from a client is never correct.
4. Verify against a Supabase branch or a copy first. This is not a change to prove in production.

## 5. The pattern already available

Defect C/D/F establishes the shape twice — `barred_at` and `is_non_punching` — and it works
regardless of grants:

- a `BEFORE INSERT OR UPDATE` trigger refuses the column unless a transaction-local flag is set;
- only a PIN-gated `security definer` RPC sets that flag;
- the RPC verifies the passcode **inside**, first, because the anon key is public;
- every change writes an `awol_events` row naming the actor.

For a handful of columns that is proportionate and needs no grant surgery. **For 27 columns it is
not** — the grant is the right instrument at that scale, with triggers reserved for the few fields
where the audit row matters as much as the permission.

A reasonable end state: narrowed grant covering the records-only columns, RPCs for the
consequential ones, triggers on the two or three where provenance must be provable.

## 6. Out of scope here

- Hashing `pin` — its own spec, per §12 of the detector spec. **Sequence it with this one.**
- `RLS`. It is disabled project-wide and turning it on is a much larger change.
- The same audit on other tables. `attendance_records` is pay data and `settings` holds
  `tg_token`; both deserve the same review and neither is in this document.

## 8. Same family: the admin credential can be replaced, and it logs as a bootstrap

Found 2026-07-30 during a real lockout. Not the `employees` grant, but the same root cause — an
authorization secret whose integrity depends on nobody having database access — so it is recorded
here rather than spawning a third document.

**There is no in-app way to change the admin PIN without knowing the current one.**
`admin_change_passcode(p_current, p_new)` requires it; `admin_bootstrap_passcode(p_new)` raises
while a credential row exists. Both by design.

**So the only recovery is deleting the credential row in SQL, then bootstrapping.** Written up as
`docs/runbooks/kiosk-admin-passcode-reset.md`, because until 2026-07-30 no recovery path was
documented anywhere and the one line in `owner-passcode-reset.md` that mentioned this credential was
stale by ten days.

**The consequence is the defect:** anyone with database access can delete the credential and set
their own, and **it is indistinguishable from a legitimate first-time setup.**

- `admin_bootstrap_passcode` writes **no audit row**.
- There is no `settings_audit` equivalent for `kiosk_admin_credential`.
- The delete leaves nothing behind — including the old `updated_at`, the only trace of when the
  previous PIN was set.
- Afterwards the table shows one row with a recent `updated_at` and no way to tell whether that was
  the owner recovering access or somebody else taking it.

A takeover and a recovery leave **identical** traces. That matters because this credential is what
every PIN-gated step of the disciplinary workflow authenticates against — the same chain §2
describes. Rewriting `employees.pin` and replacing `kiosk_admin_credential` reach the same place by
different doors, and closing one leaves the other open.

**Required, alongside the §4 work:**

1. An audit table for credential changes — at minimum `{action, actor, at}` with
   `action in ('bootstrap','change','break-glass')`. `bootstrap` on a table that already had a row
   deleted moments earlier is the signature to make visible.
2. `admin_bootstrap_passcode` and `admin_change_passcode` both write to it, in the same transaction
   as the credential write, so a change cannot exist without its audit row (the same atomicity rule
   as Defect B in the detector spec).
3. Decide whether `delete` on `kiosk_admin_credential` should be blocked outright and replaced by an
   explicit `admin_reset_passcode()` that records the reset. That would remove the break-glass
   procedure's reliance on a raw delete and give the reset a name in the log.
4. Revisit whether "one shared PIN for every device and every action" is still the right model. It
   makes the audit trail say *what* happened but never *who* — a limitation the twin-notice process
   inherits, since an NTE's defensibility rests on identifying the person who acted.

**S7 (acceptance).** A credential change of any kind writes an audit row naming the actor and the
action. Demonstrated for all three paths: normal change, bootstrap, break-glass reset.

## 7. Acceptance criteria

**S1.** The exact union of columns written by every live client caller is enumerated and listed,
derived not sampled.
**S2.** `anon` holds `UPDATE` on only those columns. Verified via `information_schema.column_privileges`.
**S3.** `pin`, `daily_rate`, `vl_balance`, `sl_balance`, `is_awol_clerk` are **not** in the anon grant.
**S4.** A direct REST write to `pin` with the anon key is refused. Demonstrated.
**S5.** Personnel form, salary edit, PIN assignment, balance edit, issuer toggle, home-yard change
and kiosk employee sync all still work — walked through on localhost, each one exercised.
**S6.** No pay figure changes. `daily_rate` moving from client-writable to RPC-writable must not
alter a single stored rate; before/after comparison to the centavo.
