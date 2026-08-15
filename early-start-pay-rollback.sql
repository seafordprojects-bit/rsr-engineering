-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  ROLLBACK — early-start-pay.sql
--
--  STATUS: NOT APPLIED. Emergency use only.
--  Pairs with: early-start-pay.sql (standing rule — every migration ships its rollback, written at
--  the same time, in the same commit).
--
--  READ THIS BEFORE RUNNING ANYTHING
--  The default position is DO NOTHING. early_start_paid is an ADDITIVE NULLABLE column: leaving it
--  in place breaks no code, costs nothing, and blocks no future work. If the payroll build is
--  reverted, the column simply stops being read — NULL and false are already identical in effect.
--
--  Dropping it DESTROYS the record of which days the owner authorized an early start. Those days
--  will silently revert to the 08:00 snap the next time payroll recomputes the week — and because
--  payroll has no stored payslips, an already-paid week would then compute to a DIFFERENT number
--  than was paid, with nothing on screen saying so.
--
--  STEP 2 therefore REFUSES the drop while any row has the flag set, unless you deliberately
--  override it. That refusal is the point of this file.
--
--  The audit trail SURVIVES either way: the {"field":"early_start_paid"} entries live in
--  attendance_edit_audit.changes (jsonb), which this file never touches.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — WHICH DATABASE AM I IN? ────────────────────────────────────────────────────────
-- Same two-project rule as the forward migration, and it matters more here: this file DROPS.
-- CLOSE THE OTHER PROJECT'S TAB FIRST.

-- 0a. Name the database.
select current_database();

-- 0b. CANARY — must return a row count. An error means WRONG PROJECT. Stop.
select count(*) as attendance_rows_must_be_nonzero from public.attendance_records;


-- ── STEP 1 — WHAT WOULD BE LOST ─────────────────────────────────────────────────────────────
-- Read this before deciding. Run it even if you are sure.

-- 1a. How many worker-days carry the flag, and whose.
select employee_code,
       count(*) filter (where early_start_paid is true) as authorized_days,
       min(date)                                        as earliest,
       max(date)                                        as latest
  from public.attendance_records
 where early_start_paid is true
 group by employee_code
 order by authorized_days desc, employee_code;

-- 1b. The full list, so it can be screenshotted before anything is dropped.
select id, employee_code, employee_name, date, timein, timeout, worked_ms, ot_ms
  from public.attendance_records
 where early_start_paid is true
 order by employee_code, public.att_date_iso(date);

-- 1c. The audit trail of every authorization. This SURVIVES the drop — kept here so the reviewer
--     can confirm the evidence is not what is being destroyed.
select a.id, a.employee_code, a.date, a.actor, a.source, a.reason, a.created_at, c as change
  from public.attendance_edit_audit a
  cross join lateral jsonb_array_elements(a.changes) c
 where c ->> 'field' = 'early_start_paid'
 order by a.created_at;


-- ── STEP 2 — DROP, GUARDED ──────────────────────────────────────────────────────────────────
-- REFUSES while any row has early_start_paid = true, because dropping then silently changes what
-- those days pay. To override deliberately — having read STEP 1 and accepted the consequence —
-- set the flag below to '1'. It is transaction-local and expires with this transaction.
begin;

-- UNCOMMENT THE NEXT LINE ONLY IF YOU HAVE READ STEP 1 AND ACCEPT LOSING THOSE AUTHORIZATIONS:
-- select set_config('early_start.force_drop', '1', true);

do $$
declare
  v_used  bigint;
  v_force boolean := coalesce(nullif(current_setting('early_start.force_drop', true), ''), '0') = '1';
begin
  if to_regclass('public.attendance_records') is null then
    raise exception 'attendance_records does not exist — WRONG PROJECT. Nothing dropped.';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'attendance_records'
                    and column_name = 'early_start_paid') then
    raise notice 'early_start_paid is already absent — nothing to do.';
    return;
  end if;

  select count(*) into v_used
    from public.attendance_records
   where early_start_paid is true;

  if v_used > 0 and not v_force then
    raise exception
      'REFUSING TO DROP early_start_paid: % worker-day(s) are authorized. Dropping reverts them to the 08:00 snap and changes what already-paid weeks compute to. Read STEP 1, then uncomment the set_config line to override.', v_used;
  end if;

  if v_used > 0 then
    raise notice 'FORCED: dropping early_start_paid with % authorized worker-day(s). Those days revert to the 08:00 snap.', v_used;
  end if;

  alter table public.attendance_records drop column early_start_paid;
  raise notice 'early_start_paid dropped.';
end $$;

commit;


-- ── STEP 3 — VERIFY ─────────────────────────────────────────────────────────────────────────
-- The editor swallows RAISE NOTICE. Re-query; do not trust the absence of an error message.

-- 3a. The column is gone. Expect ZERO rows.
select column_name
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'attendance_records'
   and column_name  = 'early_start_paid';

-- 3b. The table is otherwise intact — same row count as before you started.
select count(*) as attendance_rows_unchanged from public.attendance_records;

-- 3c. The audit trail is untouched. Expect the same count STEP 1c returned.
select count(*) as early_start_audit_entries_still_present
  from public.attendance_edit_audit a
  cross join lateral jsonb_array_elements(a.changes) c
 where c ->> 'field' = 'early_start_paid';


-- ── STEP 4 — THE CODE SIDE ──────────────────────────────────────────────────────────────────
-- Dropping the column alone does NOT fully revert. payroll/index.html still reads
-- rec.early_start_paid === true, which is harmless (undefined is not true, so every day snaps to
-- 08:00 exactly as before this feature) and the probe recordsHaveEarlyStart() will now return
-- false, so the client stops sending the field. The build is therefore SAFE against a dropped
-- column and needs no emergency redeploy — revert the payroll commit at leisure.
