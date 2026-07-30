# Runbook — Kiosk/dashboard admin passcode reset (break-glass)

**Purpose:** recover the **server-side admin passcode** — the 6-digit PIN verified by
`admin_verify_passcode` — when nobody knows the current value.

**This is NOT `owner_pin`.** For that, see `owner-passcode-reset.md`. The two are unrelated
credentials with unrelated storage and unrelated recovery. Confusing them is the most likely
mistake in this document's neighbourhood, which is why it says so twice.

> **Project:** `wpmcbjrisuyjvobvzaus` **only** (RLS disabled). Never point this at the old
> abandoned Supabase project banned in CLAUDE.md — any URL containing it is a bug.

**Written 2026-07-30**, after a lockout during the AWOL Defect C/D/F work. Until then there was
**no documented recovery path at all** for this credential.

---

## ⚠ Read this before you start

**This resets the PIN for every device at once.** There is one credential, shared by the kiosk
Admin panel on both tablets and by every PIN-gated action on the dashboard — AWOL decisions,
`awol_set_barred`, `set_non_punching`, `set_awol_clerk`, `leave_decide`, Edit-times.

**The moment you delete the row, whoever is mid-shift at Carmen loses the Admin panel** and cannot
tick a letter, recover a stuck punch, or reinstate anyone until you tell them the new PIN in person.
Mandaue too, when its kiosk is commissioned.

So:

1. **Do it when nobody needs Admin** — end of shift, not mid-morning.
2. **Have the new PIN chosen before you start**, not during.
3. **Tell Jamaica and the yard coordinator immediately afterwards.** She performs the
   letter-received step; if she cannot get into Admin, the disciplinary flow stops.

---

## Before break-glass: is it actually lost?

`admin_verify_passcode` returning `false` does **not** mean the credential is broken. Two cheaper
explanations first:

**The global throttle may be locking you out, not the PIN.** After 10 wrong tries in a rolling
15-minute window, *all* verification is denied — and a locked state is deliberately
indistinguishable from a wrong PIN, so there is no way to tell them apart by trying. Check:

```sql
select fails, window_start, locked_until, now() as now_utc
  from public.admin_verify_throttle where id;
```

If `locked_until` is in the future, **stop and wait it out.** Nothing is wrong with the credential.

**`updated_at` is not a "last used" timestamp.** `admin_verify_passcode` only reads
`kiosk_admin_credential`; a successful verify writes `admin_verify_throttle`, never the credential
row. So an `updated_at` weeks old is normal for a PIN in daily use, and is **not** evidence the PIN
has changed or gone stale.

```sql
select id, updated_at, length(passcode_hash) as hash_len
  from public.kiosk_admin_credential;
-- EXPECT: exactly 1 row. hash_len ~60 for bcrypt. Never select passcode_hash itself.
```

**Do not brute-force.** Each wrong attempt spends one of ten, and hitting the limit locks both
tablets out of Admin for 15 minutes. If two attempts have failed, stop attempting.

---

## The break-glass procedure

Run in the **Supabase SQL editor**, project `wpmcbjrisuyjvobvzaus`, one step at a time.

### Why a temporary value, and not the real PIN

`admin_bootstrap_passcode` takes the new PIN **as a literal argument**, so whatever you type lands
in **Supabase's query history** and stays there. Setting the real PIN this way would defeat the
point of hashing it: the plaintext would be recoverable by anyone with dashboard access to the
project.

So: bootstrap a **throwaway** value here, then rotate to the real PIN **through the app**, where it
is never written to query history.

### STEP 1 — record the state you are about to destroy

```sql
select id, updated_at from public.kiosk_admin_credential;
select fails, window_start, locked_until from public.admin_verify_throttle where id;
```

Screenshot both. The old `updated_at` is the only trace of when the previous PIN was set, and
deleting the row removes it.

### STEP 2 — delete the credential

```sql
delete from public.kiosk_admin_credential;
select count(*) as must_be_0 from public.kiosk_admin_credential;
-- EXPECT: 0
```

**From this moment Admin is unavailable on every device.** `admin_verify_passcode` returns `false`
for every input, because `exists (select 1 ...)` over an empty table is false.

`admin_bootstrap_passcode` raises while a row exists, which is why the delete comes first. That
guard is what makes the function unable to silently overwrite a working PIN — it is doing its job,
not obstructing you.

### STEP 3 — bootstrap the temporary PIN

```sql
select public.admin_bootstrap_passcode('000000');
-- EXPECT: 'ok — admin PIN set'
```

Exactly 6 digits, `0-9`, enforced by the function. `000000` is deliberately obvious — it exists for
the next few minutes only.

### STEP 4 — clear the throttle

Old failures otherwise count against the new PIN, and you may already be part-way to a lockout.

```sql
update public.admin_verify_throttle
   set fails = 0, window_start = now(), locked_until = null, updated_at = now()
 where id;

select fails, locked_until from public.admin_verify_throttle where id;
-- EXPECT: 0 · null
```

### STEP 5 — verify the temporary PIN

```sql
select public.admin_verify_passcode('000000') as must_be_true;
-- EXPECT: true
```

If this returns `false`, stop and do not continue to STEP 6 — something is wrong beyond a
forgotten PIN, and the system is currently in a no-working-PIN state that needs sorting first.

### STEP 6 — rotate to the real PIN, IN THE APP, immediately

**Dashboard → Settings → change the admin PIN.** That screen calls
`admin_change_passcode(current, new)`, so the real value travels as an app parameter and never
enters Supabase query history.

Enter `000000` as the current value and your chosen PIN as the new one.

Do **not** run `admin_change_passcode` in the SQL editor — that puts the real PIN into query history,
which is the exact thing STEP 3's throwaway value exists to avoid.

### STEP 7 — verify and close out

```sql
select id, updated_at from public.kiosk_admin_credential;
-- EXPECT: 1 row, updated_at = a few moments ago (proof STEP 6 landed)

select public.admin_verify_passcode('000000') as must_be_false;
-- EXPECT: false — the temporary value is gone
```

Then, on each physical tablet: unlock the kiosk Admin panel with the new PIN. **Do not assume it
works because the SQL says so** — the same discipline as reading the version stamp by eye.

---

## The audit gap this leaves

**A break-glass reset is indistinguishable from a legitimate first-time setup.**

`admin_bootstrap_passcode` writes no audit row. There is no `settings_audit` equivalent for
`kiosk_admin_credential`, and the delete leaves nothing behind. After this procedure the table shows
one row with a recent `updated_at` and nothing to say whether that was the owner recovering access
or somebody else taking it.

**So this procedure must be recorded by hand.** Note the date, the reason, and who ran it — in the
job log, or as a note appended to this file. Until an audit table exists, the paper record is the
only record.

That gap is written up as a defect in
`docs/superpowers/specs/2026-07-30-anon-grant-surface-on-employees.md` §8 — anyone with database
access can replace the admin credential, and it logs as a bootstrap rather than a takeover. It is
the same family as the plaintext-PIN item and belongs in the same fix.

---

## Verification checklist

- `kiosk_admin_credential` has exactly 1 row with a fresh `updated_at`.
- `admin_verify_throttle` reads `fails = 0`, `locked_until = null`.
- `admin_verify_passcode('000000')` returns **false**.
- The new PIN opens the kiosk Admin panel **on each physical tablet**, confirmed by eye.
- Jamaica and the yard coordinator have been told the new PIN in person.
- The reset is written down somewhere durable, with date, reason and who ran it.
