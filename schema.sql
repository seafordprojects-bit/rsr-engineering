-- ============================================================
-- RSR Suite — Borrow & Issuance schema
-- Run this in Supabase: SQL Editor → New query → paste → Run
-- ============================================================
-- Notes baked in from our planning:
--   * server-side timestamps via now()  (never trust device clocks)
--   * active flag instead of hard-delete (keeps history intact)
--   * indexes on every column we filter / sort / join on
--   * RLS enabled (with a DEV-ONLY open policy you MUST tighten)
-- ============================================================

-- ---------- SITES ----------
-- e.g. Main Warehouse, MV Seafarer, Offshore Platform A
create table if not exists sites (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- EMPLOYEES (master — the root everything links to) ----------
create table if not exists employees (
  id          uuid primary key default gen_random_uuid(),
  emp_code    text unique,            -- human-readable e.g. EMP-001
  full_name   text not null,
  position    text,
  site_id     uuid references sites(id),
  active      boolean not null default true,   -- soft-delete: set false, never DELETE
  created_at  timestamptz not null default now()
);

-- ---------- ITEMS (tools / materials) ----------
-- If you ALREADY have an items table from the inventory system,
-- skip this block and just make sure it has an id we can reference.
create table if not exists items (
  id          uuid primary key default gen_random_uuid(),
  item_code   text unique,            -- e.g. TOOL-014, MAT-220
  name        text not null,
  category    text,                   -- free text: grinder, welding rod, etc.
  unit        text default 'pcs',     -- pcs, kg, m, set...
  track_type  text not null default 'borrow',  -- 'borrow' (returns) | 'issue' (consumed)
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- BORROW / ISSUANCE (the transaction) ----------
create table if not exists borrow_issuance (
  id              uuid primary key default gen_random_uuid(),
  txn_type        text not null,               -- 'borrow' | 'issuance'
  item_id         uuid not null references items(id),
  employee_id     uuid not null references employees(id),  -- borrower / receiver
  site_id         uuid references sites(id),
  quantity        numeric not null default 1,
  status          text not null default 'out', -- borrow: 'out'|'returned'  issuance: 'issued'
  issued_by       text,                         -- warehouse staff who released it
  project_vessel  text,                         -- what it's for
  notes           text,
  borrowed_at     timestamptz not null default now(),  -- SERVER time on insert
  due_at          timestamptz,                  -- expected return (borrows only)
  returned_at     timestamptz,                  -- filled on return
  return_condition text,
  created_at      timestamptz not null default now()
);

-- ---------- INDEXES (this is what keeps the kiosk fast at scale) ----------
create index if not exists idx_emp_active        on employees(active);
create index if not exists idx_item_active        on items(active);
create index if not exists idx_bi_employee        on borrow_issuance(employee_id);
create index if not exists idx_bi_item            on borrow_issuance(item_id);
create index if not exists idx_bi_site            on borrow_issuance(site_id);
create index if not exists idx_bi_status          on borrow_issuance(status);
create index if not exists idx_bi_borrowed_at     on borrow_issuance(borrowed_at);
-- composite: matches our most common query "what's still out at this site"
create index if not exists idx_bi_status_site     on borrow_issuance(status, site_id);

-- ---------- RETURN as a server-side function (server time, not device time) ----------
create or replace function mark_returned(txn_id uuid, cond text)
returns void
language sql
as $$
  update borrow_issuance
     set status = 'returned',
         returned_at = now(),     -- server clock, always
         return_condition = cond
   where id = txn_id;
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table sites           enable row level security;
alter table employees       enable row level security;
alter table items           enable row level security;
alter table borrow_issuance enable row level security;

-- DEV-ONLY: lets the anon key read/write so the scaffold works today.
-- ⚠ TIGHTEN THIS before real payroll/salary data lives in the same project:
--   replace `to anon` with `to authenticated` and add role checks.
create policy dev_all_sites   on sites           for all to anon using (true) with check (true);
create policy dev_all_emp     on employees       for all to anon using (true) with check (true);
create policy dev_all_items   on items           for all to anon using (true) with check (true);
create policy dev_all_bi      on borrow_issuance for all to anon using (true) with check (true);

-- ---------- A little seed data so you see something on first load ----------
insert into sites (name) values ('Main Warehouse'), ('MV Seafarer'), ('Offshore Platform A')
  on conflict do nothing;
