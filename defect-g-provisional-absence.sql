-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  DEFECT G — STEP 1: the two columns. Additive, nullable, no behaviour change.
--
--  Design: docs/superpowers/specs/2026-08-03-defect-g-provisional-absence-design.md
--  Motivating incident: rev2 §4.1 — RSR 0015 reported six days in advance to Jamaica, nothing was
--  entered, and a factually wrong NTE reached paper one hand-over from service.
--
--  THIS STEP ADDS NOTHING BUT STORAGE. No row uses these columns until the entry surface ships,
--  and nothing reads them yet. It is deliberately separate so the columns are LIVE AND VERIFIED
--  before any code names them — naming a column in an explicit select before its migration is
--  applied is the b64ed5c failure, which 400'd the whole dashboard employee list.
--
--  WHY leave_requests AND NOT A NEW TABLE: the absence chain already reads this table in three
--  client sites and every walkthrough's BREAK clause. A new table would need its own sync, its own
--  grants, four new reads, and would still be joined into the same predicate. Nothing is gained.
--
--  PAY IMPACT: NONE, by construction. payroll/index.html:735 pays only
--  LEAVE_PAID = {'Vacation Leave','Sick Leave'}; a 'Reported Absence' row counts as unpaid days.
--  And payroll selects .eq('status','Approved'), so a 'Provisional' row is invisible to it entirely.
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── STEP 0 — PRECHECK. Read-only. ───────────────────────────────────────────────────────────

-- 0a. The table as it stands. Note the columns, so the additions are visibly additions.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'leave_requests'
 order by ordinal_position;
-- [PASTE RESULT]

-- 0b. Statuses and types already in use — the new values must not collide with an existing meaning.
select status, count(*) as rows from public.leave_requests group by status order by 2 desc;
select type,   count(*) as rows from public.leave_requests group by type   order by 2 desc;
-- [PASTE RESULT]
-- STOP CONDITION: an existing row already carries status 'Provisional' or type 'Reported Absence'.
-- They would be swept into the new behaviour without anyone deciding that.

-- 0c. Is anything enforcing the status vocabulary? A check constraint would reject 'Provisional'.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint where conrelid = 'public.leave_requests'::regclass;
-- [PASTE RESULT]


-- ── STEP 1 — the columns ────────────────────────────────────────────────────────────────────
-- BOTH NULLABLE. Every existing row keeps working, and a row entered without them is still a valid
-- row — the dates and filed_by are what the chain and the audit need.
--
-- reported_to and filed_by are SEPARATE ON PURPOSE. In the motivating incident they would have been
-- the same person (Jamaica). For Allan and Art they would not have been — those absences were
-- reported to the owner. Collapsing them loses the chain of custody, which is precisely what gets
-- contested when a notice is challenged.
alter table public.leave_requests
  add column if not exists reported_to  text,   -- WHO he told: Jamaica, the owner, a coordinator
  add column if not exists reported_how text;   -- HOW: in person, call, text, through a workmate

comment on column public.leave_requests.reported_to  is
  'Defect G: who the worker reported the absence TO. Distinct from filed_by, who entered the row.';
comment on column public.leave_requests.reported_how is
  'Defect G: how the report reached us — in person, call, text, via a workmate.';


-- ── STEP 2 — VERIFY ─────────────────────────────────────────────────────────────────────────

select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'leave_requests'
   and column_name in ('reported_to','reported_how');
-- [PASTE RESULT]
-- Both present, both nullable.

-- Nothing existing broke: every row still readable, and none has the new columns populated.
select count(*) as total_rows,
       count(reported_to)  as with_reported_to,
       count(reported_how) as with_reported_how
  from public.leave_requests;
-- [PASTE RESULT]

-- AND THE TWO CONSUMERS MUST STILL LOAD. Both use select('*'), so new columns arrive harmlessly —
-- but that is the assumption to test, not to assert. Open each and confirm it renders:
--   · payroll/index.html   — reads .eq('status','Approved'); a Provisional row is invisible to it
--   · the RSR Admin dashboard leave list (home.js:224)
-- [PASTE RESULT — both loaded / which failed]


-- ── NOT IN THIS STEP ────────────────────────────────────────────────────────────────────────
--  · The entry surface (Jamaica + the owner + coordinators, per owner decision 4a). It NAMES these
--    columns, so it waits until STEP 2 above has been read back live.
--  · The escalation for a Provisional row undecided past 5 working days (owner 4c): a daily Telegram
--    line, red in pending, top of the AWOL Cases tile. It NEVER expires and it KEEPS SUPPRESSING —
--    expiry would be a machine deciding a disciplinary matter, which is the same class of error as
--    a sweep barring a man.
--  · The worker is told NOTHING by G (owner 4d). The report is his own act. Denial notification
--    belongs to the E decision flow, not to capture.
--
--  ALREADY DONE, IN THE BRANCH BUILD, INDEPENDENT OF THIS MIGRATION:
--  the three detection sites now test a SET — Approved, Provisional, Pending — through
--  leaveExplains(), and every walkthrough's BREAK clause matches. Those read `status` only, so they
--  are safe before these columns exist. Pay checks (onLWPToday, isLWP) deliberately still test
--  'Approved' alone, because those ask whether a day is PAID, which only an approval can answer.
