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

-- Verify a typed PIN. Returns true/false ONLY — never the hash. security definer so it can read
-- the locked-down table regardless of caller.
create or replace function public.admin_verify_passcode(p_input text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.kiosk_admin_credential
    where passcode_hash = extensions.crypt(p_input, passcode_hash)
  );
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
