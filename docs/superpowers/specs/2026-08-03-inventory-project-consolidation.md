# The second Supabase project — `azfmpleswqixaslvcito` is LIVE, not abandoned

**Raised 2026-08-03. This-week item, not someday.**

---

## 1. The finding that reopens this

`azfmpleswqixaslvcito` is **the live shipyard-inventory system**: 24 saved queries covering tool
transfer, borrow slips and PIN verification, plus an **active daily cron** (`daily-unreturned`,
`0 9 * * *`). It is running production work today.

**`CLAUDE.md` says the opposite, and says it as a hard rule:**

> *NEVER use or reference Supabase project `azfmpleswqixaslvcito` — it is an old, abandoned project.
> Any URL containing it is a bug.*

**That instruction is false on the evidence and it is load-bearing.** It has been enforced as a
hygiene gate on every deliverable this week — grep for the string, fail if present. **Anyone
following it who found a genuine reference to the live inventory backend would treat it as a defect
and remove it.** The rule needs correcting before it causes that. Not edited here: the project's own
governing document is the owner's to change.

**The deletion plan is void as scoped.** It was written against "an old, abandoned project."

## 2. Dependency map — nothing in THIS repo reads it

Verified 2026-08-03 across every file type:

**Zero deployable files reference it.** Not one `.html`, not one `.js`. Every page that connects to
Supabase points at `wpmcbjrisuyjvobvzaus`:

```
kiosk/index.html          material-issuance/index.html     monitoring/config.js
monitoring/index.html     payroll/adjustments.html         payroll/diagnostic.html
payroll/index.html        preflight.html                   purchasing/index.html
supabase.js               tools/index.html
```

Notably `tools/index.html` and `material-issuance/index.html` — the two pages one would most expect
to depend on an inventory backend — both resolve to `wpmcbjrisuyjvobvzaus.supabase.co`.
`monitoring/borrow.html` names no project and takes its client from `supabase.js`, which also points
at `wpmcbjrisuyjvobvzaus`.

Every other match is prose: `CLAUDE.md`, session reports under `.superpowers/sdd/`, planning docs.

**THIS IS NOT A SAFETY CLEARANCE.** It is a fact about this repo. Something drives those 24 saved
queries and that daily cron — another repo, a console, a Sheets script, or hand-run queries. **Until
that consumer is identified, "nothing here reads it" says nothing about what breaks if it is
deleted.**

**The first thing to check**, because it changes the shape of everything else: whether `tools/`,
`material-issuance/` and `borrow.html` write to tables that **also exist** in the inventory project.
If the same slip is being written to two backends, or one is a stale fork of the other, the question
stops being "lock it down" and becomes "which one is authoritative".

## 3. TWO PRODUCTION PROJECTS, ONE BROWSER, IDENTICAL EDITORS

**Demonstrated live, 2026-08-03.** `defect-g-provisional-absence.sql` STEP 0 was pasted into
`azfmpleswqixaslvcito` via a leftover tab. It returned **42P01 on `leave_requests`** — read-only, no
harm, caught immediately.

**It was harmless only because the table does not exist there.** A statement naming an object that
exists in *both* projects would have run silently and correctly, in the wrong database. Every
migration this week has been pasted from a file into a browser tab, and nothing in that workflow
distinguishes the two projects except which tab is focused.

**The exposure is not symmetric.** A read in the wrong project returns an error or a wrong answer. A
**write** in the wrong project succeeds. `alter table`, `create or replace function`,
`cron.schedule`, `update settings` — all of this week's work has been of that kind.

**Mitigation available today, before any consolidation:**

- **Close the other project's tab** before running anything. The only reliable guard right now.
- **Confirm the database inside the tab**, not from the tab title:
  ```sql
  select current_database(), current_setting('cluster_name', true);
  ```
- **Lead each migration with a read that only succeeds in the intended project** — for this repo,
  `select count(*) from public.attendance_records;` errors immediately in the inventory project.

## 4. What this does NOT explain — the Friday disappearance stays open

Tempting and wrong: this is not the Friday mechanism.

On 2026-08-03 the owner checked `azfmpleswqixaslvcito` directly. `cron.job` there holds **one** row —
`daily-unreturned`, `0 9 * * *` — and `kiosk_health_snapshot` returns **42P01**. **The snapshot table
and job are in neither project.**

So Friday's install was verified live (`devices_captured = 3`, the job listed at `5 9 * * *`, both
read back after the fact) and its objects now exist nowhere. **Cause still unknown.** The
wrong-tab hypothesis is dead for that specific event and remains alive as a general hazard — a
distinction worth holding, because closing the Friday question falsely would stop the persistence
check that is currently the only thing watching for a recurrence.

`kiosk-heartbeat-snapshot.sql` STEP 5b covers it: after reinstalling, **close the tab, open a fresh
one, re-run STEP 0.**

## 5. Locking it down — shape, not a plan

Cannot be scoped properly from here: no access to that project, and nothing in this repo describes
its schema or grants. What is transferable is the pattern that worked on `wpmcbjrisuyjvobvzaus`
(`kiosk-admin-gate.sql`, named-issuer access):

- **Keep reads open where harmless; move every write behind a `security definer` RPC** that verifies
  a credential *inside* the function; then revoke direct table writes from `anon`. A `security
  definer` function bypasses grants, so the revocation can be total without breaking the flow.
- **Check first whether the issuance flow does select-then-insert from the client.** If it does,
  revoking `anon` INSERT breaks it instantly and the fix is an RPC, not a policy. This exact shape
  was hit here at `kiosk/index.html:5268-5272`.
- **Sequencing, the same trap as rev2 §10a Required #13:** locking writes while the daily cron and
  the 24 saved queries still run against open grants breaks whichever runs first. **Inventory the
  consumers before touching grants.**

**To turn this into a plan I need, from that project:** the table list with RLS status, the `anon`
grants, and what `daily-unreturned` actually does at 09:00.
