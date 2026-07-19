-- Named issuer access — authorized ISSUERS unlock Tools + Material Issuance with their own PIN.
-- Additive + idempotent. Owner runs this in the Supabase SQL editor before deploy.
alter table public.employees add column if not exists is_issuer boolean not null default false;

-- Identify an ACTIVE issuer from a typed PIN. Returns {id,name} only (never the PIN); empty if no
-- active issuer has that PIN. security definer so it reads employees.pin regardless of caller.
create or replace function public.issuer_for_pin(pin_input text)
returns table(id uuid, name text)
language sql stable security definer as $$
  select e.id, e.name from public.employees e
  where e.is_issuer = true and e.pin is not null and e.pin = pin_input
  limit 1;
$$;

-- Seed the three initial issuers (exact roster names, owner-confirmed 2026-07-19).
update public.employees set is_issuer = true
where name in ('Jamaica L. Batucan', 'Alvin H. Operio', 'Ritchie Lawan');
