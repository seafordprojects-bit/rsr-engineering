-- ============================================================================
-- Payroll manual-edit audit trail.  Run in the Supabase SQL editor, project
-- wpmcbjrisuyjvobvzaus.  Safe + idempotent.  Append-only: entries can be
-- inserted and read, never updated or deleted (a trigger blocks it).
-- Closes audit finding F4 (Edit-times rewrote punches with no record).
-- ============================================================================

create table if not exists attendance_edit_audit (
  id           bigint generated always as identity primary key,
  employee_code text not null,
  date         text not null,          -- same format as attendance_records.date
  changes      jsonb not null,         -- [{ "field": "...", "old": "...", "new": "..." }, ...]
  reason       text not null,          -- required; e.g. 'verbal agreement — owner approved'
  actor        text not null default 'owner',
  created_at   timestamptz not null default now()
);

create index if not exists idx_attendance_edit_audit_code_date
  on attendance_edit_audit (employee_code, date);

-- Append-only guard: block any UPDATE or DELETE.
create or replace function block_attendance_edit_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'attendance_edit_audit is append-only (no update/delete)';
end;
$$;

drop trigger if exists trg_attendance_edit_audit_noupd on attendance_edit_audit;
create trigger trg_attendance_edit_audit_noupd
  before update or delete on attendance_edit_audit
  for each row execute function block_attendance_edit_audit_mutation();

-- Let PostgREST see the new table immediately (else the app 404s it until the
-- schema cache reloads on its own). Harmless to re-run.
notify pgrst, 'reload schema';

-- GROUND-TRUTH CHECK (run this too): expect table=1.
select 'table' as obj, count(*) from information_schema.tables
  where table_name = 'attendance_edit_audit';
