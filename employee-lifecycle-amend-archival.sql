-- ═══════════════════════════════════════════════════════════════════════════════
--  EMPLOYEE LIFECYCLE — amendment: archival tables report, they do not block
--  Owner-approved 2026-07-28. Run AFTER employee-lifecycle.sql. Safe to re-run.
--  Replaces two functions and adds one column. Deletes nothing, blocks nothing.
--
--  WHY
--  The owner's STEP 8 run discovered TWENTY tables referencing a worker, not the twelve
--  I had enumerated by hand — a 40% miss. Among the eight missed was `allowances`, which
--  is payroll: a twelve-table check would have cleared a worker holding live allowance
--  rows as "safe to destroy". Enumeration was the wrong instrument; the catalog scan is
--  the right one and it stays.
--
--  But the scan also found bak_employee_suspensions_20260726 — a dated backup. Backup
--  tables only ever accumulate, and each one would permanently block undo for every code
--  inside it, until the feature refused everything and nobody read it any more.
--
--  THE RULE (owner, 2026-07-28): block on anything that RECORDS AN ACTION; exclude only
--  provable COPIES of other tables.
--    - attendance_edit_audit, sms_log  -> BLOCK. Someone edited this man's pay-affecting
--      times; the system sent this man a message. Both are first-hand evidence the record
--      was operated on, not a typo. attendance_edit_audit especially: attendance rows can
--      be deleted while the audit survives, so it can be the ONLY trace that pay was
--      adjusted for that code.
--    - bak_%  -> EXCLUDE from blocking. A snapshot is a copy of evidence, not evidence.
--      If a code is in a backup, either the live row still exists (and blocks anyway) or
--      it was deliberately deleted (and the backup is the archive of that decision).
--      Re-attachment cannot occur regardless, because the code is retired on delete.
--
--  WHY NOT VERIFY A SNAPSHOT STRUCTURALLY (matching row shape to its source): it fails on
--  the only backup we actually have. bak_employee_suspensions_20260726 was created in
--  awol-reinstate-flow.sql STEP 1, BEFORE STEP 3 added letter_received, last_decision,
--  manual, ref_note and the rest — so its shape already diverges from employee_suspensions
--  and a shape test would call the genuine backup "not a snapshot" and block on it.
--  Deriving "its source table" from the name is a naming convention too, so the guarantee
--  merely moves down a level.
--
--  SO THE EXCLUSION FAILS VISIBLE, NOT SILENT: every excluded table is returned BY NAME
--  and WITH ITS ROW COUNT, for the confirm dialog to display. Nothing stops someone
--  creating a bak_-prefixed table holding live data — but the admin will see it named,
--  with its hit count, before they confirm. A name alone invites a nod; a number invites
--  a question.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 1 — record the eligibility snapshot alongside each deletion ─────────
-- Makes the decision reconstructable forever: which tables were scanned, what blocked,
-- and what was skipped as archival AT THE MOMENT the record was destroyed. Without this,
-- a later reader cannot tell whether an exclusion was reasonable at the time.
alter table public.employee_deletions
  add column if not exists eligibility jsonb;

-- ── STEP 2 — eligibility: blocking vs archival, both reported ────────────────
create or replace function public.employee_delete_eligibility(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_emp      public.employees%rowtype;
  v_norm     text;
  v_tbl      record;
  v_cnt      bigint;
  v_block    bigint := 0;                 -- rows that DO block the delete
  v_arch     bigint := 0;                 -- rows in archival copies (reported, not blocking)
  v_checked  jsonb  := '[]'::jsonb;
  v_counts   jsonb  := '{}'::jsonb;       -- blocking tables with hits
  v_archived jsonb  := '{}'::jsonb;       -- EVERY archival table scanned, with its hit count
  v_is_arch  boolean;
begin
  select * into v_emp from public.employees where id = p_id;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'Employee not found', 'checked', v_checked);
  end if;
  v_norm := v_emp.code_norm;

  for v_tbl in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and t.table_type   = 'BASE TABLE'
       and c.column_name in ('employee_code', 'employee_id')
       and c.table_name not in ('employees', 'employee_deletions')
     order by c.table_name, c.column_name
  loop
    -- Matched against BOTH the normalized code AND the id-as-text: the column NAME does not
    -- tell you the content. job_checkpoint.employee_code holds a UUID.
    begin
      execute format(
        'select count(*) from public.%I where upper(regexp_replace(%I::text, ''[^A-Za-z0-9]'', '''', ''g'')) = $1 or lower(%I::text) = lower($2)',
        v_tbl.table_name, v_tbl.column_name, v_tbl.column_name)
        into v_cnt using v_norm, p_id::text;
    exception when others then
      -- FAILS CLOSED. A table that cannot be counted is a table that cannot be cleared.
      return jsonb_build_object('eligible', false,
        'reason', format('Could not check %s.%s (%s) — refusing to delete', v_tbl.table_name, v_tbl.column_name, sqlerrm),
        'checked', v_checked);
    end;

    v_checked := v_checked || to_jsonb(v_tbl.table_name || '.' || v_tbl.column_name);
    v_is_arch := v_tbl.table_name like 'bak\_%';

    if v_is_arch then
      -- EVERY archival table is reported, hits or not, so the dialog can name what it skipped.
      v_archived := v_archived || jsonb_build_object(v_tbl.table_name || '.' || v_tbl.column_name, v_cnt);
      v_arch := v_arch + v_cnt;
    elsif v_cnt > 0 then
      v_counts := v_counts || jsonb_build_object(v_tbl.table_name || '.' || v_tbl.column_name, v_cnt);
      v_block  := v_block + v_cnt;
    end if;
  end loop;

  if jsonb_array_length(v_checked) = 0 then
    return jsonb_build_object('eligible', false,
      'reason', 'No referencing tables were discovered — the check could not be computed',
      'checked', v_checked);
  end if;

  return jsonb_build_object(
    'eligible',       v_block = 0,
    'checked',        v_checked,
    'checked_count',  jsonb_array_length(v_checked),
    'counts',         v_counts,        -- blocking hits, per table
    'total',          v_block,
    'archived',       v_archived,      -- EVERY bak_ table scanned, named, with its hit count
    'archived_total', v_arch,
    'reason',         case when v_block = 0 then null
                           else 'This worker has history and cannot be deleted' end);
end $$;
grant execute on function public.employee_delete_eligibility(uuid) to anon, authenticated;

-- ── STEP 3 — the delete stores the eligibility snapshot it acted on ──────────
create or replace function public.employee_undo_mistaken_entry(
  p_id uuid, p_actor text, p_reason text, p_passcode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_emp public.employees%rowtype; v_elig jsonb;
begin
  -- Passcode FIRST, before any lookup: nothing is revealed and nothing happens without it.
  -- The anon key is published in client-side JS, so a UI-only gate would be no gate at all.
  if public.admin_verify_passcode(p_passcode) is not true then
    return jsonb_build_object('ok', false, 'reason', 'Not authorised');
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    return jsonb_build_object('ok', false, 'reason', 'A written reason of at least 10 characters is required');
  end if;

  -- Re-checked SERVER-SIDE. The button was rendered from an earlier snapshot and rows can
  -- appear in between; the client's opinion is never trusted.
  v_elig := public.employee_delete_eligibility(p_id);
  if (v_elig->>'eligible')::boolean is not true then
    return jsonb_build_object('ok', false, 'reason', coalesce(v_elig->>'reason', 'Not eligible'), 'eligibility', v_elig);
  end if;

  select * into v_emp from public.employees where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Employee not found');
  end if;

  -- Audit FIRST, delete second, one transaction. The eligibility snapshot is stored with it so
  -- a later reader can see exactly what was scanned and what was skipped as archival.
  insert into public.employee_deletions (employee_id, code, code_norm, old_row, deleted_by, reason, eligibility)
  values (v_emp.id, v_emp.code, v_emp.code_norm, to_jsonb(v_emp),
          coalesce(nullif(btrim(p_actor), ''), 'Admin'), btrim(p_reason), v_elig);

  delete from public.employees where id = p_id;

  return jsonb_build_object('ok', true, 'code', v_emp.code, 'retired_code', v_emp.code_norm, 'eligibility', v_elig);
end $$;
grant execute on function public.employee_undo_mistaken_entry(uuid, text, text, text) to anon, authenticated;

-- ── STEP 4 — verify ─────────────────────────────────────────────────────────
-- Ricky C. Ayuno. Expect: checked_count = 20, and `archived` naming every bak_ table with
-- its hit count. He was created 2026-07-27 and the backup was taken 2026-07-26, so his
-- archival hits should be 0 — if any is non-zero, stop and ask why.
select jsonb_pretty(public.employee_delete_eligibility('43a509a1-b22d-4b82-9b9b-695b8ffca4cf'));

-- Independent cross-check, deriving the same list without calling the function. If these two
-- disagree, the function is wrong and must not guard anything.
select c.table_name || '.' || c.column_name as reference,
       (xpath('/row/c/text()', query_to_xml(
          format('select count(*) as c from public.%I where upper(regexp_replace(%I::text,''[^A-Za-z0-9]'','''',''g'')) = %L or lower(%I::text) = lower(%L)',
                 c.table_name, c.column_name, 'RSR0038', c.column_name,
                 '43a509a1-b22d-4b82-9b9b-695b8ffca4cf'),
          false, true, '')))[1]::text::bigint as hits,
       (c.table_name like 'bak\_%') as archival_only
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
 where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
   and c.column_name in ('employee_code', 'employee_id')
   and c.table_name not in ('employees', 'employee_deletions')
 order by hits desc, reference;
