# Monitoring front-page restructure + roll-call phone — spec (queued 2026-07-10)

**Supersedes all earlier front-page/monitoring-restructure messages.** Smaller than previously
specced because the hub page already exists with the right groups.

## Current state (verified 2026-07-10)
- Root **CHOOSE YOUR AREA** chooser (`home.js` ~935–951) shows **two** cards: Coordinator, Issuance. No Job Monitoring card.
- **Hub** `monitoring/index.html` (commit `5c65483`) exists and exposes **all four groups publicly**:
  Field (Job Order, Roll-call), Planning (Schedule, Assign), Productivity (Efficiency, Monitor),
  Setup & checks (Work Tariff, Reconcile) + KPI diagnostic link + "Back to RSR apps".
- Admin dashboard already has a **"Job Monitoring" tile** (`home.js` ~1620) that opens the embedded
  `efficiency.html` close/approve view inside the Admin tab (commits `f94d15e`/`f76eee7`, live). Build the
  admin-gated Productivity/Setup tiles alongside this existing admin infrastructure.
- **Roll-call** (`monitoring/roll-call.html`) has **no** passcode/device gate today — publicly linked from the hub.
- The front-page third card, the hub audience-split, and the roll-call phone were **never built or deployed**.

## Scope (build when it reaches front of queue → brainstorm/plan, then walkthrough before push)

1. **Third area card.** Add a "Job Monitoring" card on the root CHOOSE YOUR AREA chooser next to
   Coordinator and Issuance, opening the existing hub (`./monitoring/`).

2. **Split the hub by audience.**
   - Public **Job Monitoring area** (the hub) shows ONLY **Field** (Job Order, Roll-call) and
     **Planning** (Schedule, Assign).
   - **Productivity** (Efficiency, Monitor) and **Setup & checks** (Work Tariff, Reconcile) move to the
     **Admin tab** as admin-gated tiles; the **KPI diagnostic** link goes admin-side too.
   - Remove Productivity/Setup/diagnostic from the public hub.

3. **Old deep-link URLs keep working** via redirects (efficiency/monitor/tariff/reconcile/diagnostic
   reachable directly for anyone with the URL/bookmark, now routed through/authorised by the admin side).

4. **Dedicated roll-call phone.**
   - Roll-call gets its **own passcode** (follow the issuance-pin pattern; settable in Admin settings).
   - **One-time device registration:** the first device to enter becomes THE roll-call device; other
     devices are refused with a "see admin" note. **Admin reset** clears the registration for phone replacement.
   - **Phone-friendly** layout + **Add-to-Home-Screen**.
   - **Supabase / KPI data flow untouched.**

## Constraints
- Interactive/worker-facing → **owner localhost walkthrough before push** (owner will check the third card,
  the slimmed hub, the admin tiles, and register the actual phone during it).
- No build step; Preact/htm via CDN; Supabase `wpmcbjrisuyjvobvzaus` only. Roll-call passcode stored in
  `settings` (like `issuance_pin`); device registration key TBD at plan time (settings vs per-device localStorage token).
