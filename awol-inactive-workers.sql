-- ═══════════════════════════════════════════════════════════════════════════════
--  AWOL inactive workers — is_active flag for the never-punched/inactive safety net
--  Owner-approved 2026-07-26, Task 9 of the AWOL suspension build.
--
--  WHY: the owner's ship-gate test (point AWOL detection at real attendance and prove it
--  suspends nobody) FAILED, flagging 10 workers. Investigation found two real-world causes:
--    (1) the Mandaue yard has never had a working kiosk (goes live this Tue/Wed) — its workers
--        (RSR 0011, RSR 0012, RSR 0018, RSR 0034) have ZERO punches, tracked on paper, and are
--        now handled by a client-side "no recent punch history" safety net (kiosk/index.html,
--        hasRecentPunchHistory) — no schema change needed for them.
--    (2) two workers no longer work here at all (RSR 0017, RSR 0020) — THIS file marks them
--        is_active = false so detection skips them permanently, not just until they punch again.
--  RSR 0000 (Manager) and RSR 0023 (Staff) are office roles that never clock in; they are covered
--  by the same never-punched safety net as Mandaue, not by this file — they stay is_active = true.
--
--  Additive + idempotent: safe to re-run in full. Matched on the NORMALIZED code (upper-cased,
--  whitespace stripped) — exactly like awol-reinstate-flow.sql STEP 12 — so a spacing or case
--  difference (e.g. "RSR 0017" vs "RSR0017") cannot silently miss or hit the wrong person.
--
--  Does NOT touch employee_suspensions or awol_events — this only affects future detection runs
--  (checkAllAbsences skips is_active = false before ever computing an absence chain).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── STEP 1 — add the column (defaults everyone to active; no behavior change on its own) ──
alter table public.employees add column if not exists is_active boolean not null default true;

-- ── STEP 2 — mark RSR 0017 (Gaviola Salvador) and RSR 0020 (John Michael Armenion) inactive ──
-- Matched on the NORMALIZED code (upper-case, whitespace stripped), same pattern as
-- awol-reinstate-flow.sql STEP 12 ("update ... where upper(regexp_replace(code, '\s', '', 'g')) = ...").
-- ONLY these two codes are touched — every other employee keeps its existing is_active value.
update public.employees set is_active = false
 where upper(regexp_replace(code, '\s', '', 'g')) = 'RSR0017';
update public.employees set is_active = false
 where upper(regexp_replace(code, '\s', '', 'g')) = 'RSR0020';

-- ── STEP 3 — RE-QUERY / verify ────────────────────────────────────────────────
-- Expect EXACTLY 2 rows: RSR 0017 Gaviola Salvador and RSR 0020 John Michael Armenion.
-- Eyeball the names below against those two before trusting this file did the right thing.
select code, name, is_active from public.employees where is_active = false order by code;
