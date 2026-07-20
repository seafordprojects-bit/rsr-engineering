-- kiosk-admin-gate.sql — server-side admin passcode for the attendance kiosk.
-- Replaces the retired client-side `admin123` password with ONE hashed 6-digit PIN, verified via
-- security-definer RPCs (modeled on issuer_for_pin). One PIN, valid on every device.
-- Additive + idempotent DDL. Owner runs this ONCE in the Supabase SQL editor.
--
-- BEFORE RUNNING: in the LAST statement, replace __PUT_YOUR_6_DIGIT_PIN_HERE__ with your chosen
--   6-digit PIN (exactly 6 digits, 0-9).
-- AFTER RUNNING: do NOT save or commit this file with your real PIN in it — put the placeholder
--   back (or discard the file). Only a bcrypt HASH is ever stored; the plaintext PIN lives
--   nowhere in the database or this repo.
--
-- pgcrypto lives in the `extensions` schema on Supabase, and these security-definer functions run
-- with search_path = public, so every crypt()/gen_salt() call is schema-qualified as
-- extensions.crypt(...) / extensions.gen_salt(...) — no search_path widening needed.

-- Ensure pgcrypto is present in the extensions schema (no-op if already installed).
create extension if not exists pgcrypto with schema extensions;

-- Single-row table holding ONLY the bcrypt hash. `id` is a boolean whose only allowed value is
-- true, so at most one row can ever exist.
create table if not exists public.kiosk_admin_credential (
  id           boolean     primary key default true check (id),
  passcode_hash text       not null,
  updated_at   timestamptz not null default now()
);

-- The project runs with RLS disabled, so by default PostgREST would expose this table's rows
-- (including the hash) to the anon key. Lock it down — no direct REST access. The security
-- definer functions below still read/write it because they run as the table owner.
revoke all on public.kiosk_admin_credential from anon, authenticated;

-- Single-row GLOBAL throttle for admin_verify_passcode. There is one shared credential and no
-- trustworthy per-caller identity (x-forwarded-for is client-rotatable; inet_client_addr() is the
-- Supabase pooler, the same for everyone), so we rate-limit the CREDENTIAL globally. REST-locked so
-- anon cannot read or reset the counters; the security-definer verify below writes it as the owner.
create table if not exists public.admin_verify_throttle (
  id            boolean     primary key default true check (id),
  fails         integer     not null default 0,
  window_start  timestamptz not null default now(),
  locked_until  timestamptz,
  updated_at    timestamptz not null default now()
);
insert into public.admin_verify_throttle (id) values (true) on conflict (id) do nothing;
revoke all on public.admin_verify_throttle from anon, authenticated;

-- Verify a typed PIN. Returns true/false ONLY — never the hash. security definer so it can read the
-- locked-down tables regardless of caller. GLOBAL fail-closed rate limit: after MAX_FAILS wrong tries
-- within a rolling window, ALL verification is denied for COOLDOWN (a locked state is indistinguishable
-- from a wrong PIN — no oracle leak). Trade-off: an attacker can deliberately lock the gate for the
-- cooldown (DoS), acceptable because the gate guards payroll VIEWING + settings, not punching.
create or replace function public.admin_verify_passcode(p_input text)
returns boolean
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_row public.admin_verify_throttle%rowtype;
  v_ok  boolean;
  MAX_FAILS constant int      := 10;                 -- wrong tries (global) before lockout
  COOLDOWN  constant interval := interval '15 minutes';
begin
  -- Lock the single throttle row: serializes ALL verifies globally (also throttles concurrency).
  insert into public.admin_verify_throttle (id) values (true) on conflict (id) do nothing;
  select * into v_row from public.admin_verify_throttle where id for update;

  -- FAIL-CLOSED: while globally locked, deny WITHOUT checking the PIN.
  if v_row.locked_until is not null and v_row.locked_until > v_now then
    update public.admin_verify_throttle set updated_at = v_now where id;
    return false;
  end if;

  -- Roll the counting window over once the cooldown has elapsed.
  if v_now - v_row.window_start > COOLDOWN then
    v_row.fails := 0;
    v_row.window_start := v_now;
  end if;

  -- The actual passcode check (unchanged bcrypt compare).
  select exists (
    select 1 from public.kiosk_admin_credential
    where passcode_hash = extensions.crypt(p_input, passcode_hash)
  ) into v_ok;

  if v_ok then
    update public.admin_verify_throttle
       set fails = 0, window_start = v_now, locked_until = null, updated_at = v_now
     where id;
    return true;
  else
    v_row.fails := v_row.fails + 1;
    update public.admin_verify_throttle
       set fails        = v_row.fails,
           window_start = v_row.window_start,
           locked_until = case when v_row.fails >= MAX_FAILS then v_now + COOLDOWN else v_row.locked_until end,
           updated_at   = v_now
     where id;
    return false;
  end if;
end;
$$;

-- One-time bootstrap: set the FIRST PIN. Fails if one already exists, so it can NEVER silently
-- overwrite — after bootstrap, changes must go through admin_change_passcode (which requires the
-- current PIN). PIN must be EXACTLY 6 digits (0-9).
create or replace function public.admin_bootstrap_passcode(p_new text)
returns text
language plpgsql security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.kiosk_admin_credential) then
    raise exception 'admin PIN already set — use admin_change_passcode to change it';
  end if;
  if p_new is null or p_new !~ '^[0-9]{6}$' then
    raise exception 'PIN must be exactly 6 digits (0-9)';
  end if;
  insert into public.kiosk_admin_credential (id, passcode_hash)
  values (true, extensions.crypt(p_new, extensions.gen_salt('bf', 10)));  -- bcrypt cost 10 (not the weak default 6)
  return 'ok — admin PIN set';
end;
$$;

-- Rotate the PIN. Requires the CURRENT PIN; returns false if it is wrong. New PIN must be EXACTLY
-- 6 digits (0-9).
create or replace function public.admin_change_passcode(p_current text, p_new text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.kiosk_admin_credential
    where passcode_hash = extensions.crypt(p_current, passcode_hash)
  ) then
    return false;                       -- wrong current PIN
  end if;
  if p_new is null or p_new !~ '^[0-9]{6}$' then
    raise exception 'new PIN must be exactly 6 digits (0-9)';
  end if;
  update public.kiosk_admin_credential
     set passcode_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)), updated_at = now()  -- bcrypt cost 10
   where id;
  return true;
end;
$$;

-- The kiosk calls verify + change with the public anon key. security definer keeps the table locked
-- while these specific entry points work.
grant  execute on function public.admin_verify_passcode(text)        to anon, authenticated;
grant  execute on function public.admin_change_passcode(text, text)  to anon, authenticated;
-- Bootstrap is OWNER-RUN-ONLY (run once in the SQL editor, which executes as a privileged role — it
-- does NOT need the anon grant). CREATE FUNCTION grants EXECUTE to PUBLIC by default, so revoke from
-- PUBLIC too: otherwise any anon caller could seize Admin by setting the first PIN whenever the
-- credential row is empty (privilege-escalation vector). The kiosk client never calls bootstrap.
revoke execute on function public.admin_bootstrap_passcode(text)     from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SET THE FIRST PIN — replace the placeholder with your chosen 6-digit PIN, then run.
-- (Running it unchanged fails validation on purpose, so a placeholder can never become the PIN.)
-- This line ERRORS harmlessly ("already set") if you ever re-run the whole file later; comment it
-- out on re-runs. Revert to the placeholder before saving/committing.
select public.admin_bootstrap_passcode('__PUT_YOUR_6_DIGIT_PIN_HERE__');

-- Optional check — expect true for your PIN, false for a wrong one:
--   select public.admin_verify_passcode('123456');   -- expect: true  (use YOUR pin)
--   select public.admin_verify_passcode('000000');   -- expect: false (a wrong pin)
