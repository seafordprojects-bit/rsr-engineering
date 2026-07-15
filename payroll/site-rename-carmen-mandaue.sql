-- ============================================================================
-- SITE RENAME — "A"/"Site A" -> "Carmen", "B"/"Site B" -> "Mandaue"
-- ----------------------------------------------------------------------------
-- Renames the stored site values in the two ATTENDANCE tables to the physical
-- yard names, matching the shared `sites` table (code CAR = Carmen, MAN = Mandaue).
--
-- SAFETY (owner conditions):
--   * Self-verifying, transaction-wrapped: the whole migration is ONE DO block =
--     ONE transaction. Any RAISE EXCEPTION rolls back EVERY change — nothing
--     partial can commit.
--   * Verifies row totals are unchanged (this is a rename, never insert/delete)
--     and that NO legacy site value survives, or it aborts.
--   * Whitespace-tolerant (btrim) per the mixed-format landmine.
--   * Re-runnable (idempotent): a second run finds 0 legacy rows and is a no-op.
--   * TEST-SITE rows are intentionally LEFT untouched (test noise; payroll filters
--     test codes out already).
--   * The shared `sites` table is NOT touched — the inventory system owns it.
--
-- HOW TO RUN (Supabase SQL editor):
--   1. Run STEP 0 (preview) alone first — it changes nothing, just shows the census.
--   2. Deploy the renamed kiosk + payroll build FIRST (they read/write yard names
--      and normalize any leftover legacy value), THEN run STEP 1 + STEP 2 here.
--   3. After it commits, run the away-allowance before/after diff (must be peso-identical).
-- ============================================================================

-- ── STEP 0 · PREVIEW (read-only — run this by itself first) ─────────────────
SELECT 'attendance_records.site' AS col, site  AS value, count(*) AS rows
  FROM attendance_records GROUP BY site
UNION ALL
SELECT 'employees.home_site',        home_site,          count(*)
  FROM employees GROUP BY home_site
ORDER BY 1, 3 DESC;

-- ── STEP 1 · RENAME (transaction-wrapped, self-verifying, rollback on mismatch) ──
DO $$
DECLARE
  a_before int; a_after int; e_before int; e_after int;
  a_A int; a_sA int; a_B int; a_sB int; a_test int; e_A int; e_B int;
  a_leftover int; e_leftover int;
  a_carmen int; a_mandaue int; e_carmen int; e_mandaue int;
BEGIN
  -- BEFORE census
  SELECT count(*) INTO a_before FROM attendance_records;
  SELECT count(*) INTO e_before FROM employees;
  SELECT count(*) FILTER (WHERE btrim(site)='A')         INTO a_A    FROM attendance_records;
  SELECT count(*) FILTER (WHERE btrim(site)='Site A')    INTO a_sA   FROM attendance_records;
  SELECT count(*) FILTER (WHERE btrim(site)='B')         INTO a_B    FROM attendance_records;
  SELECT count(*) FILTER (WHERE btrim(site)='Site B')    INTO a_sB   FROM attendance_records;
  SELECT count(*) FILTER (WHERE btrim(site)='TEST-SITE') INTO a_test FROM attendance_records;
  SELECT count(*) FILTER (WHERE btrim(home_site)='A')    INTO e_A    FROM employees;
  SELECT count(*) FILTER (WHERE btrim(home_site)='B')    INTO e_B    FROM employees;
  RAISE NOTICE 'BEFORE  attendance=% (A=%, "Site A"=%, B=%, "Site B"=%, TEST-SITE=%)  employees=% (A=%, B=%)',
    a_before, a_A, a_sA, a_B, a_sB, a_test, e_before, e_A, e_B;

  -- RENAME
  UPDATE attendance_records SET site='Carmen'      WHERE btrim(site) IN ('A','Site A');
  UPDATE attendance_records SET site='Mandaue'     WHERE btrim(site) IN ('B','Site B');
  UPDATE employees          SET home_site='Carmen' WHERE btrim(home_site) IN ('A','Site A');
  UPDATE employees          SET home_site='Mandaue' WHERE btrim(home_site) IN ('B','Site B');

  -- VERIFY totals unchanged (rename, not insert/delete)
  SELECT count(*) INTO a_after FROM attendance_records;
  SELECT count(*) INTO e_after FROM employees;
  IF a_after <> a_before THEN RAISE EXCEPTION 'ABORT: attendance_records row count changed % -> %', a_before, a_after; END IF;
  IF e_after <> e_before THEN RAISE EXCEPTION 'ABORT: employees row count changed % -> %', e_before, e_after; END IF;

  -- VERIFY no legacy value survives (TEST-SITE intentionally kept)
  SELECT count(*) INTO a_leftover FROM attendance_records WHERE btrim(site)      IN ('A','B','Site A','Site B');
  SELECT count(*) INTO e_leftover FROM employees          WHERE btrim(home_site) IN ('A','B','Site A','Site B');
  IF a_leftover <> 0 THEN RAISE EXCEPTION 'ABORT: % legacy site rows still in attendance_records', a_leftover; END IF;
  IF e_leftover <> 0 THEN RAISE EXCEPTION 'ABORT: % legacy home_site rows still in employees', e_leftover; END IF;

  -- VERIFY converted counts absorbed the legacy rows (>= tolerates a re-run / pre-named rows)
  SELECT count(*) FILTER (WHERE site='Carmen')      INTO a_carmen  FROM attendance_records;
  SELECT count(*) FILTER (WHERE site='Mandaue')     INTO a_mandaue FROM attendance_records;
  SELECT count(*) FILTER (WHERE home_site='Carmen') INTO e_carmen  FROM employees;
  SELECT count(*) FILTER (WHERE home_site='Mandaue') INTO e_mandaue FROM employees;
  IF a_carmen  < a_A + a_sA THEN RAISE EXCEPTION 'ABORT: Carmen attendance rows % < expected %',  a_carmen,  a_A + a_sA;  END IF;
  IF a_mandaue < a_B + a_sB THEN RAISE EXCEPTION 'ABORT: Mandaue attendance rows % < expected %', a_mandaue, a_B + a_sB; END IF;
  IF e_carmen  < e_A        THEN RAISE EXCEPTION 'ABORT: Carmen employees % < expected %',  e_carmen,  e_A; END IF;
  IF e_mandaue < e_B        THEN RAISE EXCEPTION 'ABORT: Mandaue employees % < expected %', e_mandaue, e_B; END IF;

  RAISE NOTICE 'AFTER   attendance Carmen=%, Mandaue=%, TEST-SITE kept=%   employees Carmen=%, Mandaue=%',
    a_carmen, a_mandaue, a_test, e_carmen, e_mandaue;
  RAISE NOTICE 'OK — site rename committed (% attendance rows, % employees rows verified).', a_after, e_after;
END $$;

-- ── STEP 2 · SEED the data-driven yard list (condition 6) ───────────────────
-- kiosk + payroll read this key to build dropdowns and validate ?site=.
-- Adding a future yard = add its name to this JSON array. No code change needed.
DELETE FROM settings WHERE key = 'attendance_sites';
INSERT INTO settings (key, value) VALUES ('attendance_sites', '["Carmen","Mandaue"]');
