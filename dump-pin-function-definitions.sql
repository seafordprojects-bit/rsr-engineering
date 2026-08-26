-- ============================================================================
-- dump-pin-function-definitions.sql
--
-- READ-ONLY. Creates nothing, changes nothing, safe to re-run, safe to run out of order.
--
-- ── HOW TO RUN ──────────────────────────────────────────────────────────────────────────────────
-- RUN ONE STEP AT A TIME. Each step below is a SINGLE statement and is completely independent of
-- every other one: select the block you want and press Run (or put the cursor in it and press
-- Ctrl+Enter). If one step errors, the others are unaffected — just run the next.
--
-- Steps 1 and 2 are the ones that matter most; 0 is the safety check; 3-6 are context.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
-- The 2026-08-24 bcrypt migration was run straight in the SQL editor. It left no file and no spec
-- in this repo, so the only record of what verify_pin / issuer_for_pin / set_employee_pin actually
-- do now is the live database. named-issuer-access.sql in this repo still shows the PRE-migration
-- issuer_for_pin (a plaintext pin = pin_input compare), which is either stale or a live bug, and
-- there is no way to tell from the repo alone.
--
-- ── FIXED 2026-08-26 (ERROR 42601 at STEP 4) ────────────────────────────────────────────────────
-- The previous version tested for a bcrypt hash with a regex containing dollar signs. The SQL
-- editor splits a script into statements on the client before sending it, and a naive splitter
-- pairs a dollar sign in one string literal with the next one it finds, swallowing the statement
-- boundary between them. The server then reported a syntax error on the FOLLOWING line ("at or
-- near count"), which is why the real culprit was one line above the reported one.
--
-- This file now contains NO dollar sign anywhere — not in a literal, not in a comment. The two
-- shape tests are written without regex instead:
--   bcrypt      -> first character is chr(36) and the second is '2'   (covers 2a / 2b / 2y)
--   six digits  -> length is 6 AND translate(value,'0123456789','') is empty
-- translate() strips every digit; an empty result means the value was all digits. Same answer, no
-- regex, no braces, no dollar signs.
--
-- FILTER (WHERE ...) was also replaced with sum(case when ... then 1 else 0 end). FILTER is valid
-- PostgreSQL, but it is one more thing to be wrong about in an editor that is already mis-parsing,
-- and the case form runs identically everywhere.
--
-- ── BEFORE YOU RUN IT (standing rule, owner 2026-08-03) ─────────────────────────────────────────
--   1. Close the OTHER Supabase project's tab (the inventory backend).
--   2. STEP 0 confirms which database you are in, from inside the tab, never from its title.
--   3. STEP 0's canary read errors immediately in the wrong project.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 0 — CANARY. Run this first, on its own. Proves this is the OPS project.
-- attendance_records does not exist in the inventory project, so a wrong tab fails here and now.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
select current_database()                                as database_name,
       current_user                                      as connected_as,
       (select count(*) from public.attendance_records)  as attendance_rows;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 1 — THE FUNCTION DEFINITIONS. This is the important one.
-- pg_get_functiondef returns the COMPLETE CREATE statement: body, language, volatility, security
-- definer flag and argument types. That is what needs to land in the repo.
--
-- The list is deliberately wider than the four asked for: awol_clerk_for_pin and time_editor_for_pin
-- are the other two reverse PIN lookups (coordinator.js), and admin_verify_passcode /
-- admin_change_passcode are the kiosk admin gate. If the migration touched one it likely touched
-- all of them, and a gap in this dump is how the next drift starts.
--
-- full_definition is long and the results grid truncates it. Click into each cell to copy the whole
-- body, or switch the result pane to JSON.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
select n.nspname                                  as schema,
       p.proname                                  as function_name,
       pg_get_function_identity_arguments(p.oid)  as arguments,
       l.lanname                                  as language,
       case p.provolatile
            when 'i' then 'immutable'
            when 's' then 'stable'
            else 'volatile'
       end                                        as volatility,
       p.prosecdef                                as security_definer,
       coalesce(p.proconfig::text, '(none)')      as function_settings,
       pg_get_functiondef(p.oid)                  as full_definition
from   pg_proc p
join   pg_namespace n on n.oid = p.pronamespace
join   pg_language  l on l.oid = p.prolang
where  n.nspname = 'public'
and    p.proname in (
         'verify_pin',
         'issuer_for_pin',
         'set_employee_pin',
         'awol_clerk_for_pin',
         'time_editor_for_pin',
         'admin_verify_passcode',
         'admin_change_passcode'
       )
order  by p.proname;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 2 — THE THROTTLE, AND ANYTHING ELSE TOUCHING A PIN OR PASSCODE.
-- The throttle was described as "verify_pin's throttling" but its name is unknown from the repo.
-- This finds it whatever it is called: any public function whose BODY mentions a pin, a passcode,
-- crypt(), or a rate / throttle / attempt / lockout concept. The seven names from STEP 1 are
-- excluded, so this is purely the things STEP 1 did not know to ask for.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
select p.proname                                  as function_name,
       pg_get_function_identity_arguments(p.oid)  as arguments,
       p.prosecdef                                as security_definer,
       coalesce(p.proconfig::text, '(none)')      as function_settings,
       pg_get_functiondef(p.oid)                  as full_definition
from   pg_proc p
join   pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public'
and    p.prokind = 'f'
and    p.proname not in (
         'verify_pin','issuer_for_pin','set_employee_pin','awol_clerk_for_pin',
         'time_editor_for_pin','admin_verify_passcode','admin_change_passcode'
       )
and    (
         pg_get_functiondef(p.oid) ilike '%pin%'
      or pg_get_functiondef(p.oid) ilike '%passcode%'
      or pg_get_functiondef(p.oid) ilike '%crypt(%'
      or pg_get_functiondef(p.oid) ilike '%gen_salt%'
      or pg_get_functiondef(p.oid) ilike '%throttl%'
      or pg_get_functiondef(p.oid) ilike '%rate_limit%'
      or pg_get_functiondef(p.oid) ilike '%lockout%'
      or pg_get_functiondef(p.oid) ilike '%failed_attempt%'
       )
order  by p.proname;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 3 — WHO MAY CALL THEM.
-- The kiosk calls these with the anon key. If anon has lost EXECUTE on one, every worker at every
-- tablet gets "No connection" and the cause is a grant, not the network. Worth having on record
-- next to the definitions.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
select p.proname                                       as function_name,
       pg_get_function_identity_arguments(p.oid)       as arguments,
       r.rolname                                       as grantee,
       has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
from   pg_proc p
join   pg_namespace n on n.oid = p.pronamespace
cross  join (
         select oid, rolname from pg_roles
         where rolname in ('anon','authenticated','service_role')
       ) r
where  n.nspname = 'public'
and    p.proname in (
         'verify_pin','issuer_for_pin','set_employee_pin','awol_clerk_for_pin',
         'time_editor_for_pin','admin_verify_passcode','admin_change_passcode'
       )
order  by p.proname, r.rolname;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 4 — IS employees.pin ACTUALLY HASHED?
-- Reports SHAPE only. No PIN and no hash is selected, so this result is safe to paste anywhere.
--   bcrypt_rows       - values that look like a bcrypt hash (first char chr(36), second char '2')
--   plaintext_6_digit - values still stored as six bare digits. MUST be 0. Anything here is a
--                       worker whose passcode never migrated; they cannot clock in at all.
--   null_or_blank     - workers with no passcode set. They cannot clock in either.
--   other_shape       - anything that is neither. Also cannot clock in.
--   duplicate_hashes  - bcrypt salts every value, so two identical hashes are impossible and this
--                       must be 0. It does NOT detect two workers who chose the SAME PIN: salting
--                       makes those hash differently. Only identify_employee_by_pin can see that,
--                       at the moment somebody types it.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
select count(*)                                                        as total_rows,
       sum(case when substr(pin,1,1) = chr(36)
                 and substr(pin,2,1) = '2'                then 1 else 0 end) as bcrypt_rows,
       sum(case when length(btrim(coalesce(pin,''))) = 6
                 and translate(btrim(coalesce(pin,'')), '0123456789', '') = ''
                                                          then 1 else 0 end) as plaintext_6_digit,
       sum(case when pin is null or btrim(pin) = ''       then 1 else 0 end) as null_or_blank,
       sum(case when pin is not null
                 and btrim(pin) <> ''
                 and not (substr(pin,1,1) = chr(36) and substr(pin,2,1) = '2')
                 and not (length(btrim(pin)) = 6
                          and translate(btrim(pin), '0123456789', '') = '')
                                                          then 1 else 0 end) as other_shape,
       (select count(*)
          from (select pin
                  from public.employees
                 where pin is not null
                 group by pin
                having count(*) > 1) d)                                as duplicate_hashes
from   public.employees;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 5 — ACTIVE WORKERS WHO CANNOT CLOCK IN.
-- After the kiosk change, identification needs a usable bcrypt hash in employees.pin. Everyone
-- listed here will type their PIN at the tablet and be refused. Run this BEFORE the walkthrough:
-- it is the list of people to fix, by name. Selects no secret.
-- An empty result is the good outcome.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
select code,
       name,
       dept,
       case when pin is null or btrim(pin) = ''
                 then 'no passcode set'
            when length(btrim(pin)) = 6
                 and translate(btrim(pin), '0123456789', '') = ''
                 then 'still plaintext - never migrated'
            else 'unrecognised passcode format'
       end as problem
from   public.employees
where  not (substr(coalesce(pin,''),1,1) = chr(36) and substr(coalesce(pin,''),2,1) = '2')
order  by dept, name;


-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- STEP 6 — WHAT COLUMNS employees ACTUALLY HAS.
--
-- This replaces a query that asked "which INACTIVE workers still hold a passcode". That question
-- assumed an is_active column. There is none — and the empty result it returned was read as
-- "nobody", which led to a filter being added to identify_employee_by_pin that raised 42703 and
-- refused every worker at every tablet until it was replaced.
--
-- An empty result and a nonexistent column look identical from the outside. So ask the schema, not
-- a predicate. This is the authority on which employment-status column, if any, exists to filter
-- on. Paste the whole result back before any status filter is written.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
select column_name,
       data_type,
       is_nullable,
       coalesce(column_default, '(none)') as column_default
from   information_schema.columns
where  table_schema = 'public'
and    table_name   = 'employees'
order  by ordinal_position;
