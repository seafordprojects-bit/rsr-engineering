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

-- Seed the three initial issuers by employee CODE, owner-confirmed 2026-07-19:
--   RSR 0025 Jamaica L. Batucan (assistant), RSR 0005 Alvin H. Operio (foreman),
--   RSR 0023 Ritchie Lawan (roll-call in-charge).
-- Match on the NORMALIZED code (upper-case, all whitespace stripped) so 'RSR 0025' == 'RSR0025',
-- exactly like the client normCode (payroll/index.html:596, kiosk/index.html:1104). Seeding by code
-- (not name) means a spacing/case difference cannot make this silently miss the intended person.
update public.employees set is_issuer = true
where upper(regexp_replace(code, '\s', '', 'g')) in ('RSR0025', 'RSR0005', 'RSR0023');

-- Verification — run after the UPDATE and eyeball the result: all three rows must show is_issuer = t.
-- If a row is missing, that code is not on the roster (check spacing/case in the roster) and that
-- issuer will NOT be able to unlock until fixed.
select code, name, is_issuer from public.employees
where upper(regexp_replace(code, '\s', '', 'g')) in ('RSR0025', 'RSR0005', 'RSR0023')
order by upper(regexp_replace(code, '\s', '', 'g'));
